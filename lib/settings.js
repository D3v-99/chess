// Shared settings schema for background, options and popup (ES module).
// content.js keeps its own copy of the few keys it needs because classic
// content scripts cannot import modules statically.

export const PROVIDERS = {
  none: { label: 'None (template explanations only)', endpoint: '', model: '', needsKey: false },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    needsKey: true,
  },
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    needsKey: true,
  },
  ollama: {
    label: 'Ollama (local)',
    endpoint: 'http://localhost:11434/api/generate',
    model: 'llama3.2',
    needsKey: false,
  },
};

export const DEFAULTS = {
  // Master switch and disclaimer acknowledgement (nothing runs until acknowledged).
  enabled: true,
  acknowledged: false,
  // Hover behaviour
  hoverExplanations: true,
  showDestinations: true,
  hoverDelayMs: 300,
  sideOverride: 'auto', // 'auto' | 'w' | 'b'
  allowFinishedGames: false,
  debug: false, // verbose console logging in the chess.com tab
  // Engine
  depth: 14,
  moveTimeMs: 2000,
  // LLM
  llmProvider: 'none',
  apiKeys: {}, // { openai: '...', deepseek: '...' }
  model: '', // empty = provider default
  endpoint: '', // empty = provider default
};

export async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s, apiKeys: { ...(s.apiKeys || {}) } };
}

/** Resolve the effective provider config (endpoint/model/key) from settings. */
export function resolveProvider(settings) {
  const id = settings.llmProvider;
  const base = PROVIDERS[id];
  if (!base || id === 'none') return null;
  return {
    id,
    endpoint: (settings.endpoint || '').trim() || base.endpoint,
    model: (settings.model || '').trim() || base.model,
    apiKey: (settings.apiKeys?.[id] || '').trim(),
    needsKey: base.needsKey,
  };
}
