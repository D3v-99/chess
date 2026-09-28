// LLM providers (OpenAI, DeepSeek, Ollama). Called only from the service worker.

export const SYSTEM_PROMPT =
  'You are a chess coach. Given FEN, the move played, engine evaluation, best move, and principal variation, ' +
  'explain in 2-3 sentences why the move is good or bad for a beginner. Focus on tactics and strategy. ' +
  'Do not suggest cheating. Be concise and encouraging.';

export class LLMError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function buildUserPrompt(ctx) {
  const r = ctx.result;
  const side = r.mover === 'w' ? 'White' : 'Black';
  const lines = [
    `FEN (before the move): ${ctx.fen}`,
    `Side to move: ${side}`,
    `Move played: ${r.san} (${r.move})`,
  ];
  if (r.quality) {
    lines.push(`Engine classification: ${r.quality}${r.cpLoss != null ? ` (centipawn loss ${r.cpLoss})` : ''}`);
    lines.push(`Evaluation (White's perspective): ${r.evalBefore} before -> ${r.evalAfter} after the move`);
    lines.push(`Engine best move: ${r.bestSan}${r.isBest ? ' (the played move)' : ''}`);
    if (r.pvSan?.length) lines.push(`Principal variation after the played move: ${r.pvSan.join(' ')}`);
    if (!r.isBest && r.bestPvSan?.length) lines.push(`Principal variation of the best move: ${r.bestPvSan.join(' ')}`);
  } else {
    lines.push('Engine evaluation: unavailable');
  }
  if (r.facts?.length) lines.push(`Detected motifs (rule-based, may be incomplete): ${r.facts.join(' ')}`);
  lines.push('Answer in plain text, 2-3 sentences, no markdown.');
  return lines.join('\n');
}

async function parseError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.error || body?.message || '';
  } catch {
    /* non-JSON body */
  }
  const retryAfter = Number(res.headers.get('retry-after')) || 0;
  const hint =
    res.status === 401 ? 'invalid API key' :
    res.status === 403 ? 'forbidden (for Ollama, set OLLAMA_ORIGINS=chrome-extension://*)' :
    res.status === 404 ? 'endpoint or model not found' :
    res.status === 429 ? 'rate limited' : `HTTP ${res.status}`;
  return new LLMError(`${hint}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`, {
    status: res.status,
    retryAfterMs: retryAfter * 1000,
  });
}

/**
 * @param {{id, endpoint, model, apiKey, needsKey}} provider  from resolveProvider()
 * @param {{fen, result}} ctx
 * @returns {Promise<string>}
 */
export async function callLLM(provider, ctx, { timeoutMs } = {}) {
  // Local models on CPU can take 10-30s per answer; cloud APIs should answer quickly.
  timeoutMs ??= provider.id === 'ollama' ? 60000 : 20000;
  if (provider.needsKey && !provider.apiKey) throw new LLMError('No API key configured');
  const user = buildUserPrompt(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res;
    if (provider.id === 'ollama') {
      res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          system: SYSTEM_PROMPT,
          prompt: user,
          stream: false,
          options: { temperature: 0.4, num_predict: 220 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw await parseError(res);
      const data = await res.json();
      return clean(data.response);
    }

    // OpenAI-compatible chat completions (OpenAI, DeepSeek, self-hosted)
    res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        max_tokens: 220,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw await parseError(res);
    const data = await res.json();
    return clean(data?.choices?.[0]?.message?.content);
  } catch (e) {
    if (e.name === 'AbortError') throw new LLMError('LLM request timed out');
    if (e instanceof LLMError) throw e;
    throw new LLMError(`Network error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function clean(text) {
  if (!text || typeof text !== 'string') throw new LLMError('Empty response from LLM');
  // Strip reasoning blocks some local models emit, and markdown emphasis.
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[*_`#]+/g, '')
    .trim()
    .slice(0, 800);
}
