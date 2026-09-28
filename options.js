import { DEFAULTS, PROVIDERS, getSettings } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const CHECKS = ['acknowledged', 'enabled', 'hoverExplanations', 'showDestinations', 'allowFinishedGames', 'debug'];

let apiKeys = {};
let currentProvider = 'none';

function fillProviders() {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.label;
    $('llmProvider').append(opt);
  }
}

function updateProviderUI() {
  const id = $('llmProvider').value;
  const p = PROVIDERS[id];
  const none = id === 'none';
  $('apiKeyRow').hidden = none || !p.needsKey;
  $('modelRow').hidden = none;
  $('endpointRow').hidden = none;
  $('test').disabled = none;
  $('model').placeholder = p.model ? `${p.model} (default)` : '';
  $('endpoint').placeholder = p.endpoint ? `${p.endpoint} (default)` : '';
  $('apiKey').value = apiKeys[id] || '';
  $('providerHint').textContent = {
    none: 'Explanations come from built-in tactical rules (hanging pieces, forks, pins, skewers, discovered attacks, back-rank mates…).',
    openai: 'Your key is stored only in this browser (chrome.storage.local) and sent only to the endpoint above.',
    deepseek: 'Your key is stored only in this browser (chrome.storage.local) and sent only to the endpoint above.',
    ollama: 'Runs against your local Ollama. If requests fail with 403, start Ollama with OLLAMA_ORIGINS=chrome-extension://* so it accepts extension requests.',
  }[id];
}

async function load() {
  const s = await getSettings();
  for (const k of CHECKS) $(k).checked = !!s[k];
  $('hoverDelayMs').value = s.hoverDelayMs;
  $('depth').value = s.depth;
  $('depthValue').textContent = s.depth;
  $('moveTimeMs').value = s.moveTimeMs;
  apiKeys = { ...s.apiKeys };
  currentProvider = s.llmProvider;
  $('llmProvider').value = s.llmProvider;
  $('model').value = s.model;
  $('endpoint').value = s.endpoint;
  updateProviderUI();
}

function num(id, lo, hi, fallback) {
  const v = Number($(id).value);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;
}

/** Custom endpoints outside the manifest's host list need an optional permission grant. */
async function ensureEndpointPermission(endpoint) {
  if (!endpoint) return true;
  let origin;
  try {
    const u = new URL(endpoint);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
    origin = `${u.protocol}//${u.host}/*`;
  } catch {
    throw new Error('Endpoint must be a valid http(s) URL');
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function save() {
  const status = $('saveStatus');
  status.className = 'status';
  apiKeys[$('llmProvider').value] = $('apiKey').value.trim();
  const endpoint = $('endpoint').value.trim();
  try {
    // Must run first, while we still hold the click's user gesture.
    const granted = await ensureEndpointPermission(endpoint);
    if (!granted) throw new Error('Permission for the custom endpoint was not granted');
  } catch (e) {
    status.textContent = e.message;
    status.classList.add('err');
    return false;
  }
  const next = {
    acknowledged: $('acknowledged').checked,
    enabled: $('enabled').checked,
    hoverExplanations: $('hoverExplanations').checked,
    showDestinations: $('showDestinations').checked,
    allowFinishedGames: $('allowFinishedGames').checked,
    debug: $('debug').checked,
    hoverDelayMs: num('hoverDelayMs', 0, 2000, DEFAULTS.hoverDelayMs),
    depth: num('depth', 6, 24, DEFAULTS.depth),
    moveTimeMs: num('moveTimeMs', 100, 30000, DEFAULTS.moveTimeMs),
    llmProvider: $('llmProvider').value,
    apiKeys: Object.fromEntries(Object.entries(apiKeys).filter(([, v]) => v)),
    model: $('model').value.trim(),
    endpoint,
  };
  await chrome.storage.local.set(next);
  status.textContent = next.acknowledged ? 'Saved.' : 'Saved. Tick the disclaimer box to activate the extension.';
  status.classList.add(next.acknowledged ? 'ok' : 'err');
  setTimeout(() => (status.textContent = ''), 4000);
  return true;
}

async function test() {
  const status = $('testStatus');
  status.className = 'status';
  status.textContent = 'Saving and testing…';
  if (!(await save())) {
    status.textContent = '';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'testLLM' });
  if (res?.ok) {
    status.textContent = `OK: “${res.text.slice(0, 140)}${res.text.length > 140 ? '…' : ''}”`;
    status.classList.add('ok');
  } else {
    status.textContent = `Failed: ${res?.error || 'unknown error'}`;
    status.classList.add('err');
  }
}

fillProviders();
$('llmProvider').addEventListener('change', () => {
  apiKeys[currentProvider] = $('apiKey').value.trim();
  currentProvider = $('llmProvider').value;
  // Model/endpoint overrides are provider-specific; reset to that provider's defaults.
  $('model').value = '';
  $('endpoint').value = '';
  updateProviderUI();
});
$('depth').addEventListener('input', () => ($('depthValue').textContent = $('depth').value));
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
load();
