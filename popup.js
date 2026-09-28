import { getSettings } from './lib/settings.js';

const $ = (id) => document.getElementById(id);

async function init() {
  const s = await getSettings();
  $('enabled').checked = s.enabled;
  $('hoverExplanations').checked = s.hoverExplanations;
  $('sideOverride').value = s.sideOverride;
  showOverrideWarning(s.sideOverride);

  for (const id of ['enabled', 'hoverExplanations']) {
    $(id).addEventListener('change', () => chrome.storage.local.set({ [id]: $(id).checked }).then(refreshStatus));
  }
  $('sideOverride').addEventListener('change', () => {
    showOverrideWarning($('sideOverride').value);
    chrome.storage.local.set({ sideOverride: $('sideOverride').value }).then(() => setTimeout(refreshStatus, 300));
  });
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('copyFen').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('fen').textContent);
    $('copyFen').textContent = 'Copied';
  });

  if (!s.acknowledged) {
    $('pageStatus').textContent = 'Open Options and accept the disclaimer to activate.';
    $('pageStatus').className = 'status err';
  }
  refreshStatus();
}

function showOverrideWarning(v) {
  $('overrideWarn').hidden = v === 'auto';
  $('overrideSide').textContent = v === 'w' ? 'White' : 'Black';
}

function formatDiagnostics(st) {
  const d = st.diagnostics || {};
  const o = d.overlay || {};
  const lines = [
    `page:          ${d.url} (${st.allowed ? 'allowed' : 'blocked'}: ${st.reason})`,
    `board:         ${st.boardFound ? `found via ${d.boardSelector} at ${d.boardRect}` : 'NOT FOUND'}`,
    `pieces read:   ${d.pieces}   legal moves: ${d.legalMoves}   (${d.chessLib})`,
    `side to move:  ${st.turn === 'w' ? 'White' : 'Black'}${d.sideOverride !== 'auto' ? ' (forced by override)' : ' (auto)'}   flipped: ${st.flipped}`,
    `mouse events:  ${d.pointerEventsSeen}${d.pointerEventsSeen ? '' : '  <- none seen yet: move the mouse over the board'}`,
    `last hover:    ${d.lastHover ? `${d.lastHover.sq ?? 'off board'}: ${d.lastHover.outcome}` : 'none'}`,
    `overlay:       ${o.mounted ? `mounted, ${o.topLayer ? 'top layer' : 'z-index only'}, ${o.styles} styles` : 'NOT MOUNTED'}`,
    `tooltip:       ${o.tooltipVisible ? `visible at ${JSON.stringify(o.tooltipRect)}` : 'hidden'}   dots: ${o.dots ?? 0}`,
  ];
  return lines.join('\n');
}

async function refreshStatus() {
  const s = await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageEl = $('pageStatus');
  if (!tab?.url?.startsWith('https://www.chess.com/')) {
    pageEl.textContent = 'Open a chess.com analysis board to use Chess Coach.';
    pageEl.className = 'status';
  } else {
    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'getPageStatus' });
      pageEl.textContent = st.active
        ? `Active on this page. ${st.turn === 'w' ? 'White' : 'Black'} to move${st.flipped ? ' (board flipped)' : ''}.`
        : `Inactive: ${st.reason}`;
      pageEl.className = `status ${st.active ? 'ok' : s.acknowledged ? '' : 'err'}`;
      $('fen').textContent = st.active && st.fen ? st.fen : '';
      $('copyFen').hidden = !(st.active && st.fen);
      if (st.diagnostics) {
        $('diagBox').hidden = false;
        $('diag').textContent = formatDiagnostics(st);
      }
    } catch {
      pageEl.textContent = 'Reload this chess.com tab to start Chess Coach.';
      pageEl.className = 'status';
    }
  }

  const eng = await chrome.runtime.sendMessage({ type: 'engineStatus' }).catch(() => null);
  const engEl = $('engineStatus');
  if (eng?.state === 'ready') {
    engEl.textContent = 'Engine: ready (Stockfish 19 lite)';
    engEl.className = 'status ok';
  } else if (eng?.state === 'loading') {
    engEl.textContent = 'Engine: loading…';
    engEl.className = 'status';
    setTimeout(refreshStatus, 800);
  } else {
    engEl.textContent = `Engine: unavailable${eng?.error ? ` (${eng.error})` : ''}`;
    engEl.className = 'status err';
  }
}

init();
