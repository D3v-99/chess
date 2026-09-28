// Offscreen document: MV3 service workers cannot create Web Workers, so this
// hidden page hosts engine-worker.js and relays messages from background.js.

'use strict';

let status = { state: 'loading', error: null };
let worker = null;
let nextId = 1;
const pending = new Map();

try {
  worker = new Worker('engine-worker.js');
  worker.onmessage = ({ data }) => {
    if (data.type === 'status') {
      status = { state: data.state, error: data.error || null };
      return;
    }
    if (data.type === 'result') {
      const cb = pending.get(data.id);
      if (!cb) return;
      pending.delete(data.id);
      cb(data);
    }
  };
  worker.onerror = (e) => {
    status = { state: 'error', error: `Engine worker failed: ${e.message || 'unknown error'}` };
    for (const [id, cb] of pending) cb({ id, ok: false, error: status.error });
    pending.clear();
  };
} catch (e) {
  status = { state: 'error', error: `Cannot create engine worker: ${e.message}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'status') {
    sendResponse(status);
    return false;
  }

  if (msg.type === 'analyze' || msg.type === 'prefetch') {
    if (!worker || status.state === 'error') {
      sendResponse({ ok: false, error: status.error || 'Engine unavailable' });
      return false;
    }
    const id = nextId++;
    pending.set(id, sendResponse);
    worker.postMessage({ ...msg.payload, type: msg.type, id });
    return true; // async response
  }
  return false;
});
