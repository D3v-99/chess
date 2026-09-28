// Template-based move explanations: classification from engine scores plus
// rule-based detection of simple tactical/strategic motifs on the board.
// Pure logic (no chrome.* APIs) so it runs in the service worker and in Node tests.

import { Chess } from './chess.js';

export const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const SIDE = { w: 'White', b: 'Black' };
const DIRS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};
DIRS.q = [...DIRS.b, ...DIRS.r];

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** UCI score ({type:'cp'|'mate', value}) → centipawns (side-to-move POV). */
export function scoreToCp(score) {
  if (!score) return null;
  if (score.type === 'mate') {
    if (score.value === 0) return -10000;
    return score.value > 0 ? 10000 - score.value * 10 : -10000 - score.value * 10;
  }
  return score.value;
}

/** Winning chances in [-1, 1] (same logistic curve lichess uses). */
export function winChance(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 2 / (1 + Math.exp(-0.00368208 * c)) - 1;
}

/** Format a mover-POV score as a White-POV string, e.g. "+1.2", "-0.4", "M3", "-M2". */
export function formatScore(score, mover) {
  if (!score) return '?';
  const sign = mover === 'w' ? 1 : -1;
  if (score.type === 'mate') {
    const v = score.value * sign;
    if (score.value === 0) return mover === 'w' ? '-M0' : 'M0';
    return v > 0 ? `M${Math.abs(v)}` : `-M${Math.abs(v)}`;
  }
  const v = (score.value * sign) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}

export function classify({ isBest, bestCp, playedCp, bestScore, playedScore }) {
  if (isBest || bestCp - playedCp <= 5) return 'Best';
  // Walking into a forced mate that could have been avoided is always a blunder.
  const matedAfter = playedScore?.type === 'mate' && playedScore.value <= 0;
  const matedBefore = bestScore?.type === 'mate' && bestScore.value <= 0;
  if (matedAfter && !matedBefore) return 'Blunder';
  const drop = winChance(bestCp) - winChance(playedCp);
  if (drop >= 0.3) return 'Blunder';
  if (drop >= 0.2) return 'Mistake';
  if (drop >= 0.1) return 'Inaccuracy';
  return 'Good';
}

// ---------------------------------------------------------------------------
// Board helpers
// ---------------------------------------------------------------------------

const other = (c) => (c === 'w' ? 'b' : 'w');
const fileOf = (sq) => sq.charCodeAt(0) - 97;
const rankOf = (sq) => Number(sq[1]) - 1;
const sqName = (f, r) => String.fromCharCode(97 + f) + (r + 1);
const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const pname = (p) => NAMES[p.type];

function pieces(chess, color) {
  const out = [];
  for (const row of chess.board()) for (const p of row) if (p && (!color || p.color === color)) out.push(p);
  return out;
}

function material(chess, color) {
  let m = 0;
  for (const p of pieces(chess)) m += (p.color === color ? 1 : -1) * VALUES[p.type];
  return m;
}

/** Attackers of `sq` belonging to `color`, excluding a king that could not legally recapture. */
function attackersOf(chess, sq, color) {
  const list = chess.attackers(sq, color);
  const defended = chess.attackers(sq, other(color)).length > 0;
  return list.filter((s) => !(chess.get(s)?.type === 'k' && defended));
}

function cheapestAttackerValue(chess, sq, color) {
  let min = Infinity;
  for (const s of attackersOf(chess, sq, color)) min = Math.min(min, chess.get(s).type === 'k' ? 100 : VALUES[chess.get(s).type]);
  return min;
}

/** A piece is "hanging" if it can be taken for free or by a cheaper piece. */
function isHanging(chess, sq) {
  const p = chess.get(sq);
  if (!p || p.type === 'k') return false;
  const enemy = other(p.color);
  const attackers = attackersOf(chess, sq, enemy);
  if (!attackers.length) return false;
  const defenders = chess.attackers(sq, p.color).length;
  return defenders === 0 || cheapestAttackerValue(chess, sq, enemy) < VALUES[p.type];
}

/** Enemy pieces attacked by the piece standing on `from`. */
function targetsOf(chess, from) {
  const me = chess.get(from);
  if (!me) return [];
  return pieces(chess, other(me.color)).filter((t) => chess.attackers(t.square, me.color).includes(from));
}

/** Walk sliding rays from `from`; report pins and skewers created by that slider. */
function lineMotifs(chess, from) {
  const me = chess.get(from);
  if (!me || !DIRS[me.type]) return [];
  const found = [];
  for (const [df, dr] of DIRS[me.type]) {
    let f = fileOf(from) + df;
    let r = rankOf(from) + dr;
    let first = null;
    while (onBoard(f, r)) {
      const p = chess.get(sqName(f, r));
      if (p) {
        if (p.color === me.color) break;
        if (!first) {
          first = { ...p, square: sqName(f, r) };
        } else {
          const second = { ...p, square: sqName(f, r) };
          if (first.type === 'k' && VALUES[second.type] >= 3) {
            found.push({ kind: 'skewer', front: first, back: second });
          } else if (second.type === 'k' && first.type !== 'k') {
            found.push({ kind: 'pin', absolute: true, front: first, back: second });
          } else if (first.type !== 'k' && VALUES[second.type] > VALUES[first.type] && VALUES[first.type] < VALUES[me.type] + 1) {
            found.push({ kind: 'pin', absolute: false, front: first, back: second });
          } else if (first.type === 'q' && VALUES[second.type] >= 3 && me.type !== 'q') {
            found.push({ kind: 'skewer', front: first, back: second });
          }
          break;
        }
      }
      f += df;
      r += dr;
    }
  }
  return found;
}

/** Valuable targets (king, queen, rook) attacked by `color`'s sliders, as "from>to" keys. */
function sliderAttackPairs(chess, color) {
  const pairs = new Set();
  for (const t of pieces(chess, other(color))) {
    if (!['k', 'q', 'r'].includes(t.type)) continue;
    for (const a of chess.attackers(t.square, color)) {
      if (['b', 'r', 'q'].includes(chess.get(a).type)) pairs.add(`${a}>${t.square}`);
    }
  }
  return pairs;
}

function forkTargets(chess, sq) {
  const me = chess.get(sq);
  if (!me) return [];
  const v = me.type === 'k' ? 100 : VALUES[me.type];
  return targetsOf(chess, sq).filter(
    (t) => t.type === 'k' || VALUES[t.type] > v || (VALUES[t.type] >= 3 && chess.attackers(t.square, t.color).length === 0),
  );
}

function describeMaterial(n) {
  n = Math.round(Math.abs(n));
  if (n === 1) return 'a pawn';
  if (n === 2) return 'two pawns';
  if (n === 3) return 'a piece';
  if (n === 4) return 'a piece and a pawn';
  if (n === 5) return 'a rook';
  if (n >= 9) return 'the queen or more';
  return `about ${n} points of material`;
}

function uciToObj(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

/** Play a UCI line on a copy of `fen`; returns SAN list and the Chess instances after each ply. */
function playLine(fen, uciMoves, maxPlies = 12) {
  const chess = new Chess(fen);
  const san = [];
  const moves = [];
  for (const uci of (uciMoves || []).slice(0, maxPlies)) {
    let m;
    try {
      m = chess.move(uciToObj(uci));
    } catch {
      break;
    }
    san.push(m.san);
    moves.push(m);
  }
  return { chess, san, moves };
}

/**
 * Material swing (mover POV) along a PV, measured at the first quiet point
 * after the opening sequence of captures so we don't stop mid-exchange.
 */
function materialSwing(fen, uciMoves, mover) {
  const chess = new Chess(fen);
  const start = material(chess, mover);
  const line = (uciMoves || []).slice(0, 10);
  for (let i = 0; i < line.length; i++) {
    try {
      chess.move(uciToObj(line[i]));
    } catch {
      break;
    }
    const next = line[i + 1];
    const nextIsCapture = !!next && chess.get(next.slice(2, 4)) != null;
    if (i >= 3 && !nextIsCapture) break;
  }
  return material(chess, mover) - start;
}

function isBackRankMate(fen, uciMoves) {
  const { chess, moves } = playLine(fen, uciMoves, 20);
  if (!chess.isCheckmate() || !moves.length) return false;
  const last = moves[moves.length - 1];
  if (!['r', 'q'].includes(last.piece)) return false;
  const loser = chess.turn();
  const king = pieces(chess, loser).find((p) => p.type === 'k');
  const backRank = loser === 'w' ? '1' : '8';
  return king && king.square[1] === backRank && last.to[1] === backRank;
}

// ---------------------------------------------------------------------------
// Motif detection
// ---------------------------------------------------------------------------

function tacticalFacts(fen, move, mover, played) {
  const facts = []; // {key, text, weight}
  const before = new Chess(fen);
  const after = new Chess(fen);
  const m = after.move(uciToObj(move));
  const enemy = other(mover);
  const moved = after.get(m.to);

  if (after.isCheckmate()) {
    facts.push({ key: 'checkmate', weight: 100, text: `${m.san} is checkmate!` });
    return { facts, m, after };
  }
  if (after.isStalemate()) {
    const matAdv = material(after, mover);
    facts.push({
      key: 'stalemate',
      weight: 90,
      text: matAdv > 0 ? 'This stalemates the opponent, throwing away a winning position as a draw.' : 'This leads to stalemate, a draw.',
    });
  }

  // Captures
  if (m.captured) {
    const wasFree = before.attackers(m.to, enemy).length === 0;
    if (wasFree) facts.push({ key: 'wins-free', weight: 60, text: `It captures an undefended ${NAMES[m.captured]} on ${m.to}.` });
    else if (VALUES[m.captured] > VALUES[m.piece]) facts.push({ key: 'good-trade', weight: 40, text: `It takes a ${NAMES[m.captured]} with a ${NAMES[m.piece]}, a favourable trade.` });
  }

  // Check / discovered attacks
  const pairsBefore = sliderAttackPairs(before, mover);
  const pairsAfter = sliderAttackPairs(after, mover);
  for (const key of pairsAfter) {
    const [a, t] = key.split('>');
    if (a === m.to || pairsBefore.has(key) || a === m.from) continue;
    const target = after.get(t);
    const slider = after.get(a);
    if (target.type === 'k') facts.push({ key: 'discovered-check', weight: 70, text: `Moving the ${pname(moved)} uncovers a discovered check from the ${pname(slider)} on ${a}.` });
    else facts.push({ key: 'discovered-attack', weight: 55, text: `It opens a discovered attack: the ${pname(slider)} on ${a} now hits the ${pname(target)} on ${t}.` });
    break;
  }
  if (after.inCheck() && !facts.some((f) => f.key === 'discovered-check')) {
    facts.push({ key: 'check', weight: 20, text: `${m.san} gives check.` });
  }

  // Fork by the moved piece
  if (!isHanging(after, m.to)) {
    const targets = forkTargets(after, m.to);
    if (targets.length >= 2) {
      const names = targets.slice(0, 3).map((t) => `${pname(t)} on ${t.square}`);
      facts.push({ key: 'fork', weight: 75, text: `The ${pname(moved)} forks the ${names.join(' and the ')}.` });
    }
  }

  // Pins / skewers created by the moved piece
  for (const lm of lineMotifs(after, m.to)) {
    if (lm.kind === 'pin') {
      facts.push({
        key: 'pin',
        weight: 50,
        text: lm.absolute
          ? `It pins the ${pname(lm.front)} on ${lm.front.square} to the king, so it cannot move.`
          : `It pins the ${pname(lm.front)} on ${lm.front.square} to the ${pname(lm.back)} behind it.`,
      });
    } else {
      facts.push({
        key: 'skewer',
        weight: 65,
        text: `It skewers the ${pname(lm.front)} on ${lm.front.square}; once it moves, the ${pname(lm.back)} on ${lm.back.square} falls.`,
      });
    }
    break;
  }

  // Hanging pieces after the move
  if (moved && moved.type !== 'k' && isHanging(after, m.to) && !after.isCheckmate()) {
    facts.push({ key: 'hangs-moved', weight: 80, text: `The ${pname(moved)} on ${m.to} can simply be captured.` });
  }
  for (const p of pieces(after, mover)) {
    if (p.square === m.to || VALUES[p.type] < 3) continue;
    if (isHanging(after, p.square) && !isHanging(before, p.square)) {
      facts.push({ key: 'hangs-other', weight: 70, text: `It leaves your ${pname(p)} on ${p.square} unprotected.` });
      break;
    }
  }

  // What the opponent's best reply does
  if (played?.pv?.length >= 2) {
    const reply = uciToObj(played.pv[1]);
    const replyBoard = new Chess(after.fen());
    let r = null;
    try {
      r = replyBoard.move(reply);
    } catch {
      /* PV mismatch; ignore */
    }
    if (r) {
      if (r.captured && VALUES[r.captured] >= 3) {
        facts.push({ key: 'reply-captures', weight: 45, text: `The opponent can answer ${r.san}, taking your ${NAMES[r.captured]}.` });
      }
      const replyForks = forkTargets(replyBoard, r.to).filter((t) => t.color === mover);
      if (replyForks.length >= 2 && !isHanging(replyBoard, r.to)) {
        facts.push({ key: 'allows-fork', weight: 72, text: `It allows ${r.san}, forking your ${replyForks.slice(0, 2).map(pname).join(' and ')}.` });
      }
      const replyLines = lineMotifs(replyBoard, r.to);
      if (replyLines.length) {
        const lm = replyLines[0];
        facts.push({
          key: lm.kind === 'pin' ? 'allows-pin' : 'allows-skewer',
          weight: 50,
          text: `It allows ${r.san}, ${lm.kind === 'pin' ? 'pinning' : 'skewering'} your ${pname(lm.front)}.`,
        });
      }
    }
  }

  // Mate scores along the played line
  if (played?.score?.type === 'mate') {
    const n = Math.abs(played.score.value);
    if (played.score.value < 0) {
      const backRank = isBackRankMate(after.fen(), played.pv.slice(1));
      const line = n <= 3 ? playLine(after.fen(), played.pv.slice(1), n * 2).san.join(' ') : '';
      facts.push({
        key: backRank ? 'allows-back-rank-mate' : 'allows-mate',
        weight: 95,
        text:
          (backRank
            ? `This allows a back-rank mate in ${n}: the king is trapped behind its own pawns`
            : `This allows a forced mate in ${n}`) + (line ? ` (${line}).` : '.'),
      });
    } else if (played.score.value > 0) {
      facts.push({ key: 'forces-mate', weight: 90, text: `This forces mate in ${n}.` });
    }
  }

  // Material swing along the played line
  if (played?.pv?.length) {
    const swing = materialSwing(fen, played.pv, mover);
    if (swing <= -2 && !facts.some((f) => f.key.startsWith('allows-mate') || f.key === 'allows-back-rank-mate')) {
      facts.push({ key: 'loses-material', weight: 68, text: `After the best reply you lose ${describeMaterial(swing)}.` });
    } else if (swing >= 2 && !m.captured) {
      facts.push({ key: 'wins-material', weight: 58, text: `The follow-up wins ${describeMaterial(swing)}.` });
    }
  }

  return { facts, m, after };
}

function strategicFacts(fen, m, after, mover) {
  const facts = [];
  const before = new Chess(fen);
  const backRank = mover === 'w' ? '1' : '8';
  const homeMinors = pieces(before, mover).filter(
    (p) => ['n', 'b'].includes(p.type) && p.square[1] === backRank,
  ).length;
  const enemyQueen = pieces(after, other(mover)).some((p) => p.type === 'q');

  if (m.flags.includes('k') || m.flags.includes('q')) {
    facts.push({ key: 'castles', weight: 30, text: 'Castling tucks the king to safety and connects the rooks.' });
  } else if (['n', 'b'].includes(m.piece) && m.from[1] === backRank) {
    facts.push({ key: 'develops', weight: 25, text: `It develops the ${NAMES[m.piece]} and brings it into the game.` });
  } else if (m.piece === 'q' && homeMinors >= 3) {
    facts.push({ key: 'early-queen', weight: 25, text: 'Bringing the queen out early lets the opponent gain time by attacking it.' });
  } else if (m.piece === 'k' && enemyQueen && pieces(after).length > 14) {
    facts.push({ key: 'king-walk', weight: 28, text: 'Moving the king this early gives up castling and can leave it exposed.' });
  }

  if (m.piece === 'p') {
    if (['d4', 'e4', 'd5', 'e5'].includes(m.to)) {
      facts.push({ key: 'center', weight: 22, text: 'It stakes a claim in the centre.' });
    }
    const f = fileOf(m.to);
    const dir = mover === 'w' ? 1 : -1;
    const passed = !pieces(after, other(mover)).some(
      (p) => p.type === 'p' && Math.abs(fileOf(p.square) - f) <= 1 && (rankOf(p.square) - rankOf(m.to)) * dir > 0,
    );
    if (passed && pieces(after).length <= 20) {
      facts.push({ key: 'passed-pawn', weight: 26, text: 'It advances a passed pawn that no enemy pawn can stop.' });
    }
    const king = pieces(after, mover).find((p) => p.type === 'k');
    if (king && king.square[1] === backRank && Math.abs(fileOf(king.square) - f) <= 1 && ['f', 'g', 'h', 'a', 'b', 'c'].includes(m.to[0]) && enemyQueen) {
      facts.push({ key: 'weakens-king', weight: 24, text: "It loosens the pawn shield in front of your king." });
    }
  }

  if (m.piece === 'r') {
    const f = m.to[0];
    const ownPawnOnFile = pieces(after, mover).some((p) => p.type === 'p' && p.square[0] === f);
    if (!ownPawnOnFile) facts.push({ key: 'open-file', weight: 22, text: `It puts the rook on the ${f}-file, where it has room to work.` });
  }

  const centralSquares = ['c3', 'd3', 'e3', 'f3', 'c4', 'd4', 'e4', 'f4', 'c5', 'd5', 'e5', 'f5', 'c6', 'd6', 'e6', 'f6'];
  if (m.piece === 'n' && ['a', 'h'].includes(m.to[0])) {
    facts.push({ key: 'rim', weight: 18, text: 'A knight on the rim controls fewer squares.' });
  } else if (m.piece === 'n' && centralSquares.includes(m.to) && !facts.some((x) => x.key === 'develops')) {
    facts.push({ key: 'central-knight', weight: 18, text: 'The knight gets a strong central post.' });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const HEADLINES = {
  Best: (san) => `${san} is the engine's top choice.`,
  Good: (san) => `${san} is a solid move.`,
  Inaccuracy: (san) => `${san} is slightly imprecise.`,
  Mistake: (san) => `${san} is a mistake.`,
  Blunder: (san) => `${san} is a blunder.`,
};

/**
 * @param {object} args
 * @param {string} args.fen   position before the move
 * @param {string} args.move  UCI move being considered
 * @param {object|null} args.analysis  { best: {move, score, pv}, played: {score, pv} } or null if no engine
 */
export function explainMove({ fen, move, analysis }) {
  const mover = new Chess(fen).turn();
  const played = analysis?.played || null;
  const best = analysis?.best || null;

  const { facts: tactical, m, after } = tacticalFacts(fen, move, mover, played);
  const strategic = strategicFacts(fen, m, after, mover);

  let quality = null;
  let cpLoss = null;
  let bestSan = null;
  let bestPvSan = [];
  let pvSan = [];
  const isBest = !!best && best.move === move;

  if (best && played) {
    const bestCp = scoreToCp(best.score);
    const playedCp = scoreToCp(played.score);
    // Centipawn loss is meaningless once mate scores are involved.
    cpLoss = best.score?.type === 'mate' || played.score?.type === 'mate' ? null : Math.max(0, bestCp - playedCp);
    quality = after.isCheckmate() ? 'Best' : classify({ isBest, bestCp, playedCp, bestScore: best.score, playedScore: played.score });
    const bl = playLine(fen, best.pv?.length ? best.pv : [best.move], 8);
    bestPvSan = bl.san;
    bestSan = bl.san[0] || null;
    pvSan = playLine(fen, played.pv?.length ? played.pv : [move], 8).san;
  }

  // Pick the most relevant facts: for good moves prefer positive motifs, for bad moves negative ones.
  const negative = new Set(['hangs-moved', 'hangs-other', 'reply-captures', 'allows-fork', 'allows-pin', 'allows-skewer', 'allows-mate', 'allows-back-rank-mate', 'loses-material', 'stalemate', 'early-queen', 'king-walk', 'weakens-king', 'rim']);
  const bad = quality === 'Mistake' || quality === 'Blunder' || quality === 'Inaccuracy';
  let pool = [...tactical];
  if (quality) pool = pool.filter((f) => (bad ? negative.has(f.key) || f.key === 'check' : !negative.has(f.key) || quality === 'Good'));
  // Strategic notes must agree with the verdict: no praise for a blunder, no nitpicks on the best move.
  if (pool.length < 2) pool.push(...strategic.filter((f) => (bad ? negative.has(f.key) : quality === 'Best' ? !negative.has(f.key) : true)));
  // A clean tactical story beats generic strategy.
  pool.sort((a, b) => b.weight - a.weight);
  const chosen = [];
  for (const f of pool) if (!chosen.some((c) => c.key === f.key)) chosen.push(f);
  const top = chosen.slice(0, 2);

  // What the better move would have achieved
  let betterText = '';
  if (best && !isBest && bestSan && quality && quality !== 'Best') {
    let why = '';
    if (best.score?.type === 'mate' && best.score.value > 0) why = `, forcing mate in ${best.score.value}`;
    else {
      const swing = materialSwing(fen, best.pv, mover);
      if (swing >= 2) why = `, which wins ${describeMaterial(swing)}`;
      else {
        const bt = tacticalFacts(fen, best.move, mover, best).facts.find((f) => ['fork', 'pin', 'skewer', 'discovered-attack', 'discovered-check', 'wins-free'].includes(f.key));
        if (bt) why = ` (${bt.key.replace('-', ' ')})`;
      }
    }
    betterText = `Better was ${bestSan}${why}.`;
  }

  const headline = quality ? HEADLINES[quality](m.san) : `${SIDE[mover]} plays ${m.san}.`;
  const parts = [headline, ...top.map((f) => f.text)];
  if (betterText) parts.push(betterText);
  if (!top.length && quality === 'Best') parts.push('It keeps the position under control.');

  return {
    move,
    san: m.san,
    mover,
    quality,
    cpLoss,
    evalBefore: best ? formatScore(best.score, mover) : null,
    evalAfter: played ? formatScore(played.score, mover) : null,
    bestMove: best?.move || null,
    bestSan,
    isBest,
    pvSan,
    bestPvSan,
    depth: played?.depth ?? best?.depth ?? null,
    motifs: chosen.map((f) => f.key),
    facts: chosen.map((f) => f.text),
    text: parts.join(' '),
  };
}

/** Group legal moves by origin square (used by content script fallback). */
export function legalMovesByFrom(fen) {
  const chess = new Chess(fen);
  return chess.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, san: m.san, promotion: m.promotion || null, captured: m.captured || null, piece: m.piece }));
}
