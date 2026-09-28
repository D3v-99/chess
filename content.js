// Chess Coach content script (classic script, runs in chess.com pages).
// Reads the board from the DOM, tracks hover, and renders an isolated tooltip.
// It never moves pieces or interacts with the game – read-only by design.

(() => {
  'use strict';

  // If an older copy is still attached (extension reloaded/updated), tell it to shut down.
  const TAKEOVER_EVENT = 'chess-coach:takeover';
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));

  const DEFAULTS = {
    enabled: true,
    acknowledged: false,
    hoverExplanations: true,
    showDestinations: true,
    hoverDelayMs: 300,
    sideOverride: 'auto',
    allowFinishedGames: false,
    llmProvider: 'none',
    debug: false,
  };

  const BOARD_SELECTORS = [
    'wc-chess-board',
    'chess-board',
    '#board-analysis-board',
    '#board-single',
    '.board',
  ];
  // Pages where the extension must never run (live/daily play, puzzles, competitions).
  // (/game/... pages are handled separately: allowed only when finished and opted in.)
  const BLOCKED_PATHS = /^\/(play|live|daily|puzzles?|puzzle-rush|tournaments?|arena|variants|votechess|bots?|computer)(\/|$)/i;
  const RUNNING_CLOCK_SELECTORS = [
    '.clock-component.clock-player-turn',
    '.clock-running',
    '.clock-component.clock-running',
    '[data-cy="clock-running"]',
  ];
  const GAME_OVER_SELECTORS = [
    '.game-over-modal-content',
    '.game-over-modal-container',
    '.game-result',
    '[data-cy="game-over-modal"]',
    '.game-review-buttons-component',
  ];
  const DISCLAIMER =
    "Educational use only. Using this in rated games violates chess.com's Terms of Service.";
  const ARM_SWITCH_DELAY_MS = 180;
  const PIECE_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };

  let settings = { ...DEFAULTS };
  let ChessCtor = null;
  let alive = true;

  // Debug logging: enable "Debug logging" in the options page, then open DevTools on the
  // chess.com tab and filter the console by "Chess Coach".
  const log = (...args) => {
    if (settings.debug) console.log('%c[Chess Coach]', 'color:#2f6fdb;font-weight:bold', ...args);
  };

  const state = {
    active: false,
    reason: 'Starting…',
    board: null,
    boardObserver: null,
    pieces: new Map(), // 'e4' → 'wp'
    flipped: false,
    turn: 'w',
    fen: null,
    legal: new Map(), // from → [{to, san, promotion, captured, piece}]
    armed: null, // { from, dests: Map to → move }
    hoverSq: null,
    reqId: 0,
    hoverTimer: 0,
    armTimer: 0,
    refreshTimer: 0,
    lastUrl: location.href,
    boardSelector: null,
    boardPos: null, // last known board rect (to tell page scrolls from inner-panel scrolls)
    lastHover: null, // { sq, outcome } for diagnostics
    pointerEvents: 0,
  };

  // -------------------------------------------------------------------------
  // Messaging helpers
  // -------------------------------------------------------------------------

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (String(e?.message).includes('Extension context invalidated')) teardown();
      return { ok: false, error: e?.message || 'Extension unavailable' };
    }
  }

  async function loadChessLib() {
    try {
      const mod = await import(chrome.runtime.getURL('lib/chess.js'));
      ChessCtor = mod.Chess;
    } catch {
      ChessCtor = null; // fall back to asking the service worker for legal moves
    }
  }

  // -------------------------------------------------------------------------
  // Page gating
  // -------------------------------------------------------------------------

  function normalizedPath() {
    // Strip optional locale prefix like /es/ or /pt-br/.
    return location.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '');
  }

  function anyMatch(selectors) {
    return selectors.some((s) => {
      try {
        return !!document.querySelector(s);
      } catch {
        return false;
      }
    });
  }

  function pageStatus() {
    if (!settings.acknowledged) return { allowed: false, reason: 'Accept the disclaimer in the options page first.' };
    if (!settings.enabled) return { allowed: false, reason: 'Disabled in the popup.' };
    const path = normalizedPath();
    if (BLOCKED_PATHS.test(path)) return { allowed: false, reason: 'Disabled on play, puzzle and competition pages.' };
    if (anyMatch(RUNNING_CLOCK_SELECTORS)) return { allowed: false, reason: 'A running game clock was detected.' };
    if (/^\/analysis(\/|$)/i.test(path)) return { allowed: true, reason: 'Analysis board' };
    if (settings.allowFinishedGames && /^\/game\//i.test(path)) {
      return anyMatch(GAME_OVER_SELECTORS)
        ? { allowed: true, reason: 'Finished game review' }
        : { allowed: false, reason: 'Waiting for the game to finish.' };
    }
    return { allowed: false, reason: 'Only active on chess.com/analysis (finished games can be enabled in options).' };
  }

  // -------------------------------------------------------------------------
  // Board reading
  // -------------------------------------------------------------------------

  const rootOf = (el) => el.shadowRoot || el;
  const sqName = (file, rank) => String.fromCharCode(96 + file) + rank; // 1-based

  function parseSquareClass(cls) {
    const m = cls.match(/\bsquare-(\d)(\d)\b/);
    if (!m) return null;
    const f = Number(m[1]);
    const r = Number(m[2]);
    if (f < 1 || f > 8 || r < 1 || r > 8) return null;
    return { file: f, rank: r, name: sqName(f, r) };
  }

  function findBoard() {
    let best = null;
    let bestArea = 0;
    const rejected = [];
    for (const sel of BOARD_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!rootOf(el).querySelector('.piece')) {
          rejected.push(`${sel}: no .piece children`);
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 120 || Math.abs(r.width - r.height) > r.width * 0.1) {
          rejected.push(`${sel}: not square/too small (${Math.round(r.width)}x${Math.round(r.height)})`);
          continue;
        }
        const area = r.width * r.height;
        if (area > bestArea) {
          best = el;
          bestArea = area;
          state.boardSelector = sel;
        }
      }
    }
    if (!best) log('findBoard: no usable board.', rejected.length ? rejected : 'No element matched any selector', BOARD_SELECTORS);
    return best;
  }

  function readPieces(board) {
    const map = new Map();
    for (const el of rootOf(board).querySelectorAll('.piece')) {
      const cls = el.getAttribute('class') || '';
      const code = cls.match(/\b([wb][prnbqk])\b/);
      const sq = parseSquareClass(cls);
      if (!code || !sq) continue;
      map.set(sq.name, code[1]);
    }
    return map;
  }

  /** Geometric flip detection (majority vote over pieces), class-based fallback. */
  function detectFlipped(board) {
    const rect = board.getBoundingClientRect();
    const size = rect.width / 8;
    let flippedVotes = 0;
    let normalVotes = 0;
    for (const el of rootOf(board).querySelectorAll('.piece')) {
      if (el.classList.contains('dragging')) continue;
      const sq = parseSquareClass(el.getAttribute('class') || '');
      const r = el.getBoundingClientRect();
      if (!sq || !r.width) continue;
      const col = Math.floor((r.left + r.width / 2 - rect.left) / size);
      if (col === sq.file - 1) normalVotes++;
      else if (col === 8 - sq.file) flippedVotes++;
      if (normalVotes + flippedVotes >= 5) break;
    }
    if (normalVotes || flippedVotes) return flippedVotes > normalVotes;
    return board.classList.contains('flipped');
  }

  function readLastMove(board, pieces) {
    const hs = [];
    for (const el of rootOf(board).querySelectorAll('.highlight')) {
      const sq = parseSquareClass(el.getAttribute('class') || '');
      if (sq && !hs.includes(sq.name)) hs.push(sq.name);
    }
    if (hs.length !== 2) return null;
    const occupied = hs.filter((s) => pieces.has(s));
    if (occupied.length !== 1) return null;
    const to = occupied[0];
    const from = hs.find((s) => s !== to);
    return { from, to, color: pieces.get(to)[0] };
  }

  function turnFromMoveList() {
    const sel = document.querySelector(
      '.node.selected, .move-node.selected, [data-node].selected, .node-highlight-content.selected',
    );
    if (!sel) return null;
    const node = sel.closest('.node, .move-node, [data-node]') || sel;
    if (node.matches('.white-move, .white') || node.querySelector('.white')) return 'b';
    if (node.matches('.black-move, .black') || node.querySelector('.black')) return 'w';
    return null;
  }

  function detectTurn(lastMove) {
    if (settings.sideOverride === 'w' || settings.sideOverride === 'b') return settings.sideOverride;
    if (lastMove) return lastMove.color === 'w' ? 'b' : 'w';
    return turnFromMoveList() || 'w';
  }

  function buildFen(pieces, turn, lastMove) {
    const rows = [];
    for (let r = 8; r >= 1; r--) {
      let row = '';
      let empty = 0;
      for (let f = 1; f <= 8; f++) {
        const code = pieces.get(sqName(f, r));
        if (!code) {
          empty++;
          continue;
        }
        if (empty) row += empty;
        empty = 0;
        row += code[0] === 'w' ? code[1].toUpperCase() : code[1];
      }
      if (empty) row += empty;
      rows.push(row);
    }
    // Castling rights inferred from king/rook home squares (DOM can't tell us history).
    let castling = '';
    if (pieces.get('e1') === 'wk') {
      if (pieces.get('h1') === 'wr') castling += 'K';
      if (pieces.get('a1') === 'wr') castling += 'Q';
    }
    if (pieces.get('e8') === 'bk') {
      if (pieces.get('h8') === 'br') castling += 'k';
      if (pieces.get('a8') === 'br') castling += 'q';
    }
    // En passant from a double pawn push highlighted as the last move.
    let ep = '-';
    if (lastMove && pieces.get(lastMove.to) === `${lastMove.color}p`) {
      const fr = Number(lastMove.from[1]);
      const tr = Number(lastMove.to[1]);
      if (lastMove.from[0] === lastMove.to[0] && Math.abs(fr - tr) === 2) ep = lastMove.to[0] + (fr + tr) / 2;
    }
    return `${rows.join('/')} ${turn} ${castling || '-'} ${ep} 0 1`;
  }

  function fenIsValid(fen) {
    if (!ChessCtor) return true; // background validates anyway
    try {
      new ChessCtor(fen);
      return true;
    } catch {
      return false;
    }
  }

  async function computeLegalMoves(fen) {
    const legal = new Map();
    let moves = [];
    if (ChessCtor) {
      try {
        moves = new ChessCtor(fen).moves({ verbose: true });
      } catch {
        moves = [];
      }
    } else {
      const res = await send({ type: 'legalMoves', fen });
      moves = res?.moves || [];
    }
    for (const m of moves) {
      if (!legal.has(m.from)) legal.set(m.from, []);
      legal.get(m.from).push({ to: m.to, san: m.san, promotion: m.promotion || null, captured: m.captured || null, piece: m.piece });
    }
    return legal;
  }

  // -------------------------------------------------------------------------
  // Refresh cycle
  // -------------------------------------------------------------------------

  function scheduleRefresh(delay = 120) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, delay);
  }

  function observeBoard(board) {
    state.boardObserver?.disconnect();
    state.boardObserver = new MutationObserver(() => scheduleRefresh());
    state.boardObserver.observe(rootOf(board), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    if (board.shadowRoot) {
      state.boardObserver.observe(board, { attributes: true, attributeFilter: ['class'] });
    }
  }

  async function refresh() {
    if (!alive) return;
    const status = pageStatus();
    state.reason = status.reason;
    if (!status.allowed) {
      if (state.active) log('deactivating:', status.reason);
      deactivate();
      return;
    }

    const board = findBoard();
    if (!board) {
      state.reason = 'No board found on this page.';
      deactivate();
      return;
    }
    if (board !== state.board) {
      state.board = board;
      observeBoard(board);
      log('board found via', state.boardSelector, board, 'rect', board.getBoundingClientRect());
    }
    state.active = true;
    state.boardPos = boardPos();
    ui.mount();

    const pieces = readPieces(board);
    const lastMove = readLastMove(board, pieces);
    let turn = detectTurn(lastMove);
    let fen = buildFen(pieces, turn, lastMove);
    if (!fenIsValid(fen) && settings.sideOverride === 'auto') {
      // e.g. the side we guessed is "not to move" is in check: try the other side.
      const alt = buildFen(pieces, turn === 'w' ? 'b' : 'w', null);
      if (fenIsValid(alt)) {
        fen = alt;
        turn = turn === 'w' ? 'b' : 'w';
      }
    }

    state.pieces = pieces;
    state.flipped = detectFlipped(board);

    if (fen === state.fen) return;
    log('position:', fen, `| ${pieces.size} pieces | turn ${turn}${settings.sideOverride !== 'auto' ? ' (FORCED by popup override)' : lastMove ? ' (from last-move highlight)' : ''} | flipped ${state.flipped}`);
    state.fen = fen;
    state.turn = turn;
    state.reqId++;
    disarm();
    ui.hideTooltip();

    if (!fenIsValid(fen)) {
      state.legal = new Map();
      state.reason = 'Position could not be read (invalid FEN).';
      return;
    }
    state.legal = await computeLegalMoves(fen);
    if (fen !== state.fen) return;
    log(`legal moves: ${[...state.legal.values()].reduce((n, l) => n + l.length, 0)} (via ${ChessCtor ? 'chess.js in page' : 'service worker'})`);
    // Warm the engine for this position so the first hover is fast.
    if (settings.hoverExplanations) send({ type: 'prefetch', fen });
  }

  function deactivate() {
    if (!state.active && !state.board) return;
    state.active = false;
    state.boardObserver?.disconnect();
    state.boardObserver = null;
    state.board = null;
    state.fen = null;
    state.reqId++;
    disarm();
    ui.hideTooltip();
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  function squareFromPoint(x, y) {
    if (!state.board) return null;
    const rect = state.board.getBoundingClientRect();
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return null;
    const size = rect.width / 8;
    const col = Math.floor((x - rect.left) / size);
    const row = Math.floor((y - rect.top) / size);
    const file = state.flipped ? 8 - col : col + 1;
    const rank = state.flipped ? row + 1 : 8 - row;
    return sqName(file, rank);
  }

  function boardPos() {
    const r = state.board?.getBoundingClientRect();
    return r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}` : null;
  }

  function squareRect(sq) {
    const rect = state.board.getBoundingClientRect();
    const size = rect.width / 8;
    const file = sq.charCodeAt(0) - 96;
    const rank = Number(sq[1]);
    const col = state.flipped ? 8 - file : file - 1;
    const row = state.flipped ? rank - 1 : 8 - rank;
    return { left: rect.left + col * size, top: rect.top + row * size, size };
  }

  // -------------------------------------------------------------------------
  // Hover handling
  // -------------------------------------------------------------------------

  let rafPending = false;
  let lastPointer = null;

  // Listen to both pointer and mouse moves; rAF coalesces them into one update per frame.
  function onMouseMove(e) {
    state.pointerEvents++;
    lastPointer = e;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (lastPointer) handlePointer(lastPointer.clientX, lastPointer.clientY);
    });
  }

  function hovered(sq, outcome) {
    state.lastHover = { sq, outcome };
    log(`hover ${sq ?? '(off board)'}: ${outcome}`);
  }

  function handlePointer(x, y) {
    if (!state.active || !state.fen) return;
    const sq = squareFromPoint(x, y);
    if (sq === state.hoverSq) return;
    state.hoverSq = sq;
    state.reqId++;
    clearTimeout(state.hoverTimer);
    clearTimeout(state.armTimer);

    if (!sq) {
      hovered(null, 'left the board');
      disarm();
      ui.hideTooltip();
      return;
    }
    if (document.querySelector(':modal')) {
      hovered(sq, 'ignored: a chess.com dialog is open');
      return;
    }
    const code = state.pieces.get(sq);
    if (code && code[0] === state.turn) {
      // Switching pieces needs a short dwell, so sweeping the mouse from a piece to its
      // destination across other own pieces doesn't re-arm them on the way.
      if (!state.armed) arm(sq);
      else if (state.armed.from !== sq) state.armTimer = setTimeout(() => arm(sq), ARM_SWITCH_DELAY_MS);
      hovered(sq, `own piece ${code}`);
      return;
    }
    if (state.armed?.dests.has(sq)) {
      if (!settings.hoverExplanations) return hovered(sq, 'destination, but hover explanations are off');
      const from = state.armed.from;
      hovered(sq, `destination of ${from}; analyzing in ${Number(settings.hoverDelayMs) || 300}ms`);
      state.hoverTimer = setTimeout(() => analyze(from, sq), Number(settings.hoverDelayMs) || 300);
      return;
    }
    if (code && !state.armed && settings.hoverExplanations) {
      // Say why nothing happens instead of staying silent (usually a wrong side-to-move).
      const side = state.turn === 'w' ? 'White' : 'Black';
      const forced = settings.sideOverride !== 'auto';
      hovered(sq, `opponent piece ${code}; it is ${side}'s turn${forced ? ' (forced by popup override)' : ''}`);
      ui.showInfo(sq, {
        title: `It's ${side}'s turn`,
        body: forced
          ? `"Side to move" is set to ${side} in the extension popup. Set it to Auto-detect, or hover a ${side} piece.`
          : `Hover a ${side} piece to see its moves. If the turn is wrong, set "Side to move" in the extension popup.`,
      });
      return;
    }
    hovered(sq, state.armed ? `not a legal destination of ${state.armed.from}` : 'empty square, no piece selected');
    ui.hideTooltip();
  }

  function arm(from) {
    const moves = state.legal.get(from) || [];
    const dests = new Map();
    for (const m of moves) {
      // One entry per destination; for promotions default to a queen.
      if (!dests.has(m.to) || m.promotion === 'q') dests.set(m.to, m);
    }
    state.armed = { from, dests };
    if (settings.showDestinations) ui.showDots(from, dests);
    else ui.clearDots();
    if (!settings.hoverExplanations) return;
    const name = PIECE_NAMES[state.pieces.get(from)[1]];
    ui.showInfo(from, {
      title: `${name} on ${from}`,
      body: dests.size
        ? `${dests.size} legal move${dests.size === 1 ? '' : 's'}. Hover a highlighted square to see how good it is.`
        : 'This piece has no legal moves right now.',
    });
  }

  function disarm() {
    state.armed = null;
    ui.clearDots();
  }

  async function analyze(from, to) {
    const move = state.armed?.dests.get(to);
    if (!move || !state.fen) return;
    const id = ++state.reqId;
    const fen = state.fen;
    const uci = from + to + (move.promotion || '');
    const stillCurrent = () => id === state.reqId && fen === state.fen && alive;

    ui.showLoading(to, move.san);
    const statusCheck = setTimeout(async () => {
      const st = await send({ type: 'engineStatus' });
      if (stillCurrent() && st?.state === 'loading') ui.setLoadingText('Starting the engine…');
    }, 400);

    log('analyze →', uci, fen);
    const t0 = performance.now();
    const res = await send({ type: 'analyzeMove', fen, move: uci });
    clearTimeout(statusCheck);
    log(`analyze ← ${uci} in ${Math.round(performance.now() - t0)}ms`, res);
    if (!stillCurrent() || res?.superseded) return;
    if (!res?.ok) {
      ui.showError(to, res?.error || 'Analysis failed');
      return;
    }
    ui.showResult(to, res.result, { engineError: res.engineError, promotion: move.promotion });

    if (settings.llmProvider && settings.llmProvider !== 'none') {
      ui.setCoachPending(true);
      const llm = await send({ type: 'explainLLM', fen, result: res.result });
      if (!stillCurrent()) return;
      ui.setCoachPending(false);
      if (llm?.ok) ui.setCoachText(llm.text);
      else ui.setCoachNote(`AI coach unavailable (${llm?.error || 'error'}), showing the built-in explanation.`);
    }
  }

  // -------------------------------------------------------------------------
  // UI (Shadow DOM overlay)
  // -------------------------------------------------------------------------

  const ui = (() => {
    let host = null;
    let dotsLayer = null;
    let tip = null;
    let anchorSq = null;

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    let sheetText = null;

    // Load styles.css as text once and apply it as a constructed stylesheet: no <link>
    // request that page CSP could block, and no flash of unstyled tooltip while it loads.
    async function loadSheet() {
      try {
        sheetText = await (await fetch(chrome.runtime.getURL('styles.css'))).text();
      } catch (e) {
        log('could not load styles.css, falling back to <link>', e);
      }
    }

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.setAttribute('data-chess-coach', '');
      // Full-viewport, click-through layer. !important so page CSS can't hide or move it.
      host.style.cssText = [
        'position:fixed', 'inset:0', 'width:100vw', 'height:100vh', 'margin:0', 'padding:0',
        'border:0', 'background:transparent', 'overflow:visible', 'max-width:none', 'max-height:none',
        'pointer-events:none', 'z-index:2147483647', 'display:block', 'visibility:visible', 'opacity:1',
      ].map((d) => `${d} !important`).join(';');
      const shadow = host.attachShadow({ mode: 'closed' });
      if (sheetText != null && 'adoptedStyleSheets' in shadow) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(sheetText);
        shadow.adoptedStyleSheets = [sheet];
      } else {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('styles.css');
        shadow.append(link);
      }
      dotsLayer = el('div', 'cc-dots');
      tip = el('div', 'cc-tip');
      tip.style.position = 'fixed'; // critical styles inline, in case the sheet fails
      tip.hidden = true;
      shadow.append(dotsLayer, tip);
      // <body> is sometimes re-rendered by the page; <html> is stable.
      document.documentElement.append(host);
      // Put the layer in the browser's top layer, above any z-index stacking context on the page.
      if (host.showPopover) {
        host.popover = 'manual';
        try {
          host.showPopover();
        } catch (e) {
          log('showPopover failed; relying on z-index', e);
        }
      }
      log('overlay mounted', { topLayer: host.matches?.(':popover-open') ?? false, styles: sheetText != null ? 'constructed' : 'link' });
    }

    function diagnostics() {
      if (!host) return { mounted: false };
      const tipRect = tip && !tip.hidden ? tip.getBoundingClientRect() : null;
      return {
        mounted: host.isConnected,
        topLayer: host.matches?.(':popover-open') ?? false,
        styles: sheetText != null ? 'constructed' : 'link',
        tooltipVisible: !!tipRect && tipRect.width > 0,
        tooltipRect: tipRect && { left: Math.round(tipRect.left), top: Math.round(tipRect.top), width: Math.round(tipRect.width) },
        dots: dotsLayer?.childElementCount ?? 0,
      };
    }

    function unmount() {
      host?.remove();
      host = dotsLayer = tip = null;
    }

    function clearDots() {
      dotsLayer?.replaceChildren();
    }

    function showDots(from, dests) {
      if (!dotsLayer) return;
      const nodes = [];
      const fromRect = squareRect(from);
      const origin = el('div', 'cc-origin');
      place(origin, fromRect);
      nodes.push(origin);
      for (const [to, m] of dests) {
        const d = el('div', m.captured ? 'cc-dot cc-capture' : 'cc-dot');
        place(d, squareRect(to));
        nodes.push(d);
      }
      dotsLayer.replaceChildren(...nodes);
    }

    function place(node, r) {
      node.style.position = 'fixed';
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.width = node.style.height = `${r.size}px`;
    }

    function positionTip(sq) {
      anchorSq = sq;
      const r = squareRect(sq);
      tip.hidden = false;
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const gap = 10;
      let left = r.left + r.size + gap;
      if (left + w > window.innerWidth - 8) left = r.left - w - gap;
      if (left < 8) left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.size / 2 - w / 2));
      let top = r.top + r.size / 2 - h / 2;
      top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }

    function render(sq, children, cls = '') {
      if (!tip) return;
      tip.className = `cc-tip ${cls}`.trim();
      tip.replaceChildren(...children, el('div', 'cc-footer', DISCLAIMER));
      positionTip(sq);
    }

    function hideTooltip() {
      if (tip) tip.hidden = true;
      anchorSq = null;
    }

    function showInfo(sq, { title, body }) {
      render(sq, [el('div', 'cc-title', title), el('div', 'cc-text', body)], 'cc-info');
    }

    function showLoading(sq, san) {
      const spinner = el('span', 'cc-spinner');
      const row = el('div', 'cc-loading');
      row.append(spinner, el('span', 'cc-loading-text', `Analyzing ${san}…`));
      render(sq, [row]);
    }

    function setLoadingText(text) {
      const t = tip?.querySelector('.cc-loading-text');
      if (t) {
        t.textContent = text;
        positionTip(anchorSq);
      }
    }

    function showError(sq, message) {
      render(sq, [el('div', 'cc-title', 'Could not analyze'), el('div', 'cc-text', message)], 'cc-error');
    }

    function showResult(sq, r, { engineError, promotion }) {
      const head = el('div', 'cc-head');
      head.append(el('span', 'cc-move', r.san));
      if (r.quality) head.append(el('span', `cc-badge cc-q-${r.quality.toLowerCase()}`, r.quality));
      const children = [head];

      if (r.quality) {
        const stats = el('div', 'cc-stats');
        const ev = el('div', 'cc-stat');
        ev.append(el('span', 'cc-label', 'Eval'), el('span', 'cc-value', `${r.evalBefore} → ${r.evalAfter}`));
        stats.append(ev);
        if (!r.isBest && r.bestSan) {
          // A move rated "Best" that isn't the engine's first choice is equally good: say so.
          const best = el('div', 'cc-stat');
          best.append(el('span', 'cc-label', r.quality === 'Best' ? 'Engine pick' : 'Best'), el('span', 'cc-value', r.bestSan));
          stats.append(best);
        }
        if (r.cpLoss != null && !r.isBest && r.quality !== 'Best') {
          const loss = el('div', 'cc-stat');
          loss.append(el('span', 'cc-label', 'Loss'), el('span', 'cc-value', `${(r.cpLoss / 100).toFixed(2)}`));
          stats.append(loss);
        }
        children.push(stats);
      }

      const text = el('div', 'cc-text cc-explanation', r.text);
      children.push(text);
      if (r.pvSan?.length > 1) {
        children.push(el('div', 'cc-pv', `Line: ${r.pvSan.slice(0, 6).join(' ')}`));
      }
      if (promotion) children.push(el('div', 'cc-note', 'Promotion shown as a queen.'));
      if (engineError) children.push(el('div', 'cc-note', `Engine unavailable (${engineError}); showing basic checks only.`));
      if (r.depth) children.push(el('div', 'cc-meta', `Stockfish depth ${r.depth}`));
      render(sq, children, r.quality ? `cc-q-${r.quality.toLowerCase()}-border` : '');
    }

    function setCoachPending(on) {
      if (!tip) return;
      let n = tip.querySelector('.cc-coach-pending');
      if (on && !n) {
        n = el('div', 'cc-note cc-coach-pending', 'AI coach is writing an explanation…');
        tip.querySelector('.cc-explanation')?.after(n);
      } else if (!on && n) n.remove();
      if (anchorSq) positionTip(anchorSq);
    }

    function setCoachText(text) {
      const t = tip?.querySelector('.cc-explanation');
      if (!t) return;
      t.textContent = text; // textContent only: never inject model output as HTML
      t.classList.add('cc-ai');
      if (anchorSq) positionTip(anchorSq);
    }

    function setCoachNote(note) {
      tip?.querySelector('.cc-explanation')?.after(el('div', 'cc-note', note));
      if (anchorSq) positionTip(anchorSq);
    }

    return {
      loadSheet, diagnostics, mount, unmount, clearDots, showDots, hideTooltip, showInfo, showLoading,
      setLoadingText, showError, showResult, setCoachPending, setCoachText, setCoachNote,
    };
  })();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function onScroll() {
    if (!state.active) return;
    // Scroll events from inner panels (move list, sidebars) don't move the board: ignore them.
    const pos = boardPos();
    if (pos === state.boardPos) return;
    state.boardPos = pos;
    log('board moved (scroll/resize); clearing hover');
    state.hoverSq = null;
    state.reqId++;
    disarm();
    ui.hideTooltip();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) if (k in DEFAULTS) settings[k] = v.newValue ?? DEFAULTS[k];
    state.fen = null; // force re-read (side override may have changed)
    scheduleRefresh(0);
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (msg?.type !== 'getPageStatus') return false;
    const status = pageStatus();
    sendResponse({
      allowed: status.allowed,
      active: state.active,
      reason: state.reason || status.reason,
      fen: state.fen,
      turn: state.turn,
      flipped: state.flipped,
      boardFound: !!state.board,
      diagnostics: {
        url: location.pathname,
        boardSelector: state.boardSelector,
        boardRect: state.board ? boardPos() : null,
        pieces: state.pieces.size,
        legalMoves: [...state.legal.values()].reduce((n, l) => n + l.length, 0),
        sideOverride: settings.sideOverride,
        chessLib: ChessCtor ? 'loaded in page' : 'service-worker fallback',
        pointerEventsSeen: state.pointerEvents,
        lastHover: state.lastHover,
        armed: state.armed?.from ?? null,
        overlay: ui.diagnostics(),
      },
    });
    return false;
  }

  const poll = setInterval(() => {
    // SPA navigation, board replacement, clocks appearing/disappearing.
    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      state.fen = null;
    }
    if (!state.board || !state.board.isConnected || state.active !== pageStatus().allowed) scheduleRefresh(0);
  }, 1000);

  function teardown() {
    if (!alive) return;
    alive = false;
    clearInterval(poll);
    clearTimeout(state.hoverTimer);
    clearTimeout(state.armTimer);
    clearTimeout(state.refreshTimer);
    state.boardObserver?.disconnect();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('pointermove', onMouseMove, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    document.removeEventListener(TAKEOVER_EVENT, teardown);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      /* context already invalidated */
    }
    ui.unmount();
  }

  async function init() {
    document.addEventListener(TAKEOVER_EVENT, teardown);
    try {
      settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
    } catch {
      return teardown();
    }
    log('content script started on', location.pathname, 'settings', settings);
    await Promise.all([loadChessLib(), ui.loadSheet()]);
    log('chess.js', ChessCtor ? 'loaded' : 'unavailable (using service worker for legal moves)');
    document.addEventListener('pointermove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    scheduleRefresh(0);
  }

  init();
})();
