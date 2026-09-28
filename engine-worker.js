// Dedicated worker that owns Stockfish (spawned as a nested worker) and speaks
// a small JSON protocol with offscreen.js:
//
//   in:  { type: 'analyze',  id, fen, move, depth, movetime }   → root + candidate-move search
//        { type: 'prefetch', id, fen, depth, movetime }          → root search only
//        { type: 'status' }
//   out: { type: 'result', id, ok, data | error }
//        { type: 'status', state: 'loading'|'ready'|'error', error? }
//
// Newer requests supersede older ones: queued work for an old request is dropped
// and a running search that the new request doesn't need is stopped.

'use strict';

const INIT_TIMEOUT_MS = 30000;
const CACHE_MAX = 600;

let sf = null;
let state = 'loading';
let initError = null;
let lineHandler = null;
let generation = 0;
let lock = Promise.resolve();
let running = null; // { key, gen, stop() }
const cache = new Map(); // key → result (LRU via Map insertion order)
const inflight = new Map(); // key → Promise

function postStatus() {
  postMessage({ type: 'status', state, error: initError });
}

function send(cmd) {
  sf.postMessage(cmd);
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      lineHandler = null;
      reject(new Error('Engine did not respond in time'));
    }, timeoutMs);
    lineHandler = (line) => {
      if (predicate(line)) {
        clearTimeout(t);
        lineHandler = null;
        resolve(line);
      }
    };
  });
}

const ready = (async () => {
  try {
    sf = new Worker('stockfish/stockfish.js');
  } catch (e) {
    throw new Error(`Could not start Stockfish worker: ${e.message}`);
  }
  sf.onmessage = (e) => lineHandler && lineHandler(String(e.data));
  sf.onerror = (e) => {
    initError = `Stockfish crashed: ${e.message || 'unknown error'}`;
    state = 'error';
    postStatus();
  };
  const uciok = waitFor((l) => l === 'uciok', INIT_TIMEOUT_MS);
  send('uci');
  await uciok;
  send('setoption name Hash value 32');
  send('setoption name MultiPV value 1');
  const readyok = waitFor((l) => l === 'readyok', INIT_TIMEOUT_MS);
  send('isready');
  await readyok;
})().then(
  () => {
    state = 'ready';
    postStatus();
  },
  (e) => {
    state = 'error';
    initError = e.message;
    postStatus();
    throw e;
  },
);
ready.catch(() => {}); // surfaced through requests and status

function parseInfo(line, acc) {
  if (!line.startsWith('info ') || line.includes(' lowerbound') || line.includes(' upperbound')) return;
  const mpv = line.match(/\bmultipv (\d+)/);
  if (mpv && mpv[1] !== '1') return;
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  const depth = line.match(/\bdepth (\d+)/);
  if (!score) return;
  acc.score = { type: score[1], value: Number(score[2]) };
  if (depth) acc.depth = Number(depth[1]);
  if (pv) acc.pv = pv[1].trim().split(/\s+/);
}

/** One UCI search. Must be called while holding the lock. */
function search(fen, { depth, movetime, searchmoves }, key) {
  return new Promise((resolve) => {
    const acc = { score: null, pv: [], depth: 0, bestmove: null, partial: false };
    let stopped = false;
    lineHandler = (line) => {
      if (line.startsWith('info ')) parseInfo(line, acc);
      else if (line.startsWith('bestmove')) {
        lineHandler = null;
        const bm = line.split(/\s+/)[1];
        acc.bestmove = bm && bm !== '(none)' ? bm : null;
        acc.partial = stopped;
        if (!acc.pv.length && acc.bestmove) acc.pv = [acc.bestmove];
        resolve(acc);
      }
    };
    running = {
      key,
      stop() {
        if (!stopped) {
          stopped = true;
          send('stop');
        }
      },
    };
    send(`position fen ${fen}`);
    let go = `go depth ${depth}`;
    if (movetime) go += ` movetime ${movetime}`;
    if (searchmoves) go += ` searchmoves ${searchmoves}`;
    send(go);
  });
}

function keyFor(fen, opts) {
  return `${fen}|${opts.depth}|${opts.movetime}|${opts.searchmoves || '*'}`;
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key, v) {
  cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

class Superseded extends Error {
  constructor() {
    super('superseded');
  }
}

/** Cached, de-duplicated, serialized search that is abandoned if `gen` goes stale. */
function cachedSearch(fen, opts, gen) {
  const key = keyFor(fen, opts);
  const hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);

  const p = new Promise((resolve, reject) => {
    lock = lock.then(async () => {
      try {
        if (gen !== generation) return reject(new Superseded());
        const again = cacheGet(key);
        if (again) return resolve(again);
        const res = await search(fen, opts, key);
        running = null;
        if (res.partial || !res.score) {
          if (gen !== generation) return reject(new Superseded());
          return resolve(res); // best effort, not cached
        }
        cacheSet(key, res);
        resolve(res);
      } catch (e) {
        running = null;
        reject(e);
      }
    });
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Start a new request generation; stop the running search unless it is still useful. */
function supersede(keepKey) {
  generation++;
  if (running && running.key !== keepKey) running.stop();
}

async function analyze(msg) {
  const opts = { depth: msg.depth, movetime: msg.movetime };
  const rootKey = keyFor(msg.fen, opts);
  supersede(rootKey);
  const gen = generation;
  await ready;

  const root = await cachedSearch(msg.fen, opts, gen);
  if (msg.type === 'prefetch') return { best: toLine(root) };

  const played =
    root.bestmove === msg.move ? root : await cachedSearch(msg.fen, { ...opts, searchmoves: msg.move }, gen);
  const best = toLine(root);
  const pl = toLine(played);
  if (pl.move !== msg.move) pl.pv = [msg.move]; // defensive: searchmoves was ignored
  // Search instability can make the restricted search score above the root search;
  // never report a candidate as better than the engine's own choice.
  if (root.bestmove !== msg.move && cpOf(pl.score) > cpOf(best.score)) pl.score = best.score;
  return { best, played: pl };
}

function toLine(r) {
  return { move: r.bestmove, score: r.score, pv: r.pv, depth: r.depth, partial: r.partial };
}

function cpOf(score) {
  if (!score) return -Infinity;
  if (score.type === 'mate') return score.value > 0 ? 100000 - score.value : -100000 - score.value;
  return score.value;
}

onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'status') return postStatus();
  if (msg.type !== 'analyze' && msg.type !== 'prefetch') return;
  try {
    const data = await analyze(msg);
    postMessage({ type: 'result', id: msg.id, ok: true, data });
  } catch (err) {
    postMessage({ type: 'result', id: msg.id, ok: false, error: err.message, superseded: err instanceof Superseded });
  }
};

postStatus();
