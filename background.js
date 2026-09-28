// Service worker: routes messages between the content script, the Stockfish
// engine (hosted in an offscreen document) and LLM providers.

import { Chess } from './lib/chess.js';
import { explainMove, legalMovesByFrom } from './lib/explain.js';
import { callLLM, LLMError } from './lib/llm.js';
import { getSettings, resolveProvider } from './lib/settings.js';

const OFFSCREEN_URL = 'offscreen.html';
const LLM_MIN_INTERVAL_MS = 1200;
const LLM_CACHE_MAX = 300;

// ---------------------------------------------------------------------------
// Offscreen engine host
// ---------------------------------------------------------------------------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Runs the Stockfish chess engine in a Web Worker for local analysis.',
      })
      .catch((e) => {
        // Another caller may have created it concurrently.
        if (!String(e?.message).includes('single offscreen')) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function toOffscreen(type, payload = {}) {
  await ensureOffscreen();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', type, payload });
    } catch (e) {
      // The document may still be booting its listener right after creation.
      if (!String(e?.message).includes('Receiving end does not exist') || attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
}

async function engineAnalyze(type, fen, move, settings) {
  const res = await toOffscreen(type, {
    fen,
    move,
    depth: clamp(Number(settings.depth) || 14, 4, 30),
    movetime: clamp(Number(settings.moveTimeMs) || 2000, 100, 30000),
  });
  if (!res) throw new Error('No response from engine');
  if (!res.ok) {
    const err = new Error(res.error || 'Engine error');
    err.superseded = !!res.superseded;
    throw err;
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// LLM with cache + simple rate limiting
// ---------------------------------------------------------------------------

const llmCache = new Map();
let llmNextAllowedAt = 0;
let llmCooldownUntil = 0;
let llmChain = Promise.resolve();

function llmQueued(fn) {
  // Serialize calls so bursts of hovers can't fan out into parallel requests.
  const run = llmChain.then(async () => {
    const now = Date.now();
    if (now < llmCooldownUntil) {
      throw new LLMError(`Rate limited; retrying in ${Math.ceil((llmCooldownUntil - now) / 1000)}s`);
    }
    const wait = llmNextAllowedAt - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    llmNextAllowedAt = Date.now() + LLM_MIN_INTERVAL_MS;
    return fn();
  });
  llmChain = run.catch(() => {});
  return run;
}

async function explainWithLLM({ fen, result }) {
  const settings = await getSettings();
  const provider = resolveProvider(settings);
  if (!provider) return { ok: false, error: 'LLM disabled' };
  if (provider.needsKey && !provider.apiKey) return { ok: false, error: `No ${provider.id} API key set in options` };

  const key = `${provider.id}|${provider.model}|${fen}|${result.move}|${result.quality}`;
  if (llmCache.has(key)) return { ok: true, text: llmCache.get(key), cached: true };

  try {
    const text = await llmQueued(() => callLLM(provider, { fen, result }));
    llmCache.set(key, text);
    while (llmCache.size > LLM_CACHE_MAX) llmCache.delete(llmCache.keys().next().value);
    return { ok: true, text };
  } catch (e) {
    if (e instanceof LLMError && e.status === 429) {
      llmCooldownUntil = Date.now() + (e.retryAfterMs || 30000);
    }
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function validate(fen, move) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (e) {
    throw new Error(`Could not read the board position (${e.message})`);
  }
  if (move) {
    try {
      chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    } catch {
      throw new Error(`Illegal move ${move} in this position`);
    }
  }
}

async function handleAnalyzeMove({ fen, move }) {
  validate(fen, move);
  const settings = await getSettings();
  let analysis = null;
  let engineError = null;
  try {
    analysis = await engineAnalyze('analyze', fen, move, settings);
  } catch (e) {
    if (e.superseded) return { ok: false, superseded: true };
    engineError = e.message;
  }
  const result = explainMove({ fen, move, analysis });
  return { ok: true, result, engineError };
}

const handlers = {
  async analyzeMove(msg) {
    return handleAnalyzeMove(msg);
  },
  async prefetch({ fen }) {
    validate(fen);
    const settings = await getSettings();
    try {
      await engineAnalyze('prefetch', fen, null, settings);
      return { ok: true };
    } catch (e) {
      return { ok: false, superseded: !!e.superseded, error: e.message };
    }
  },
  async legalMoves({ fen }) {
    return { ok: true, moves: legalMovesByFrom(fen) };
  },
  async explainLLM(msg) {
    return explainWithLLM(msg);
  },
  async testLLM() {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 2 3';
    const result = explainMove({ fen, move: 'f3f7', analysis: null });
    llmCache.clear();
    return explainWithLLM({ fen, result });
  },
  async engineStatus() {
    try {
      return { ok: true, ...(await toOffscreen('status')) };
    } catch (e) {
      return { ok: false, state: 'error', error: e.message };
    }
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  // Only accept requests from our own content scripts / extension pages.
  if (sender.id !== chrome.runtime.id) return false;
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

// ---------------------------------------------------------------------------
// Install: show options (disclaimer) and inject into already-open chess.com tabs
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  const tabs = await chrome.tabs.query({ url: 'https://www.chess.com/*' });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
});
