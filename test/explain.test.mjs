// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMove, classify, formatScore, scoreToCp } from '../lib/explain.js';

const cp = (value) => ({ type: 'cp', value });
const mate = (value) => ({ type: 'mate', value });

test('classification thresholds', () => {
  assert.equal(classify({ isBest: true, bestCp: 50, playedCp: -500 }), 'Best');
  assert.equal(classify({ isBest: false, bestCp: 30, playedCp: 20 }), 'Good');
  assert.equal(classify({ isBest: false, bestCp: 30, playedCp: -40 }), 'Inaccuracy');
  assert.equal(classify({ isBest: false, bestCp: 30, playedCp: -300 }), 'Blunder');
  // In a completely winning position, dropping a little doesn't matter.
  assert.equal(classify({ isBest: false, bestCp: 1200, playedCp: 900 }), 'Good');
});

test('score formatting is White POV', () => {
  assert.equal(formatScore(cp(120), 'w'), '+1.2');
  assert.equal(formatScore(cp(120), 'b'), '-1.2');
  assert.equal(formatScore(mate(3), 'b'), '-M3');
  assert.equal(formatScore(mate(-2), 'b'), 'M2');
  assert.ok(scoreToCp(mate(1)) > scoreToCp(mate(5)));
  assert.ok(scoreToCp(mate(-1)) < scoreToCp(mate(-5)));
});

test('detects a knight fork (Nc7+ forking king and rook)', () => {
  // Black king e8, rook a8; white knight b5 jumps to c7.
  const fen = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
  const r = explainMove({
    fen,
    move: 'b5c7',
    analysis: {
      best: { move: 'b5c7', score: cp(480), pv: ['b5c7', 'e8d7', 'c7a8'], depth: 14 },
      played: { move: 'b5c7', score: cp(480), pv: ['b5c7', 'e8d7', 'c7a8'], depth: 14 },
    },
  });
  assert.equal(r.quality, 'Best');
  assert.ok(r.motifs.includes('fork'), r.text);
  assert.match(r.text, /forks/);
});

test('detects a hanging piece and names the better move', () => {
  // White queen d1 steps to d5, where the e6 pawn takes it for free.
  const fen = '4k3/8/4p3/8/8/8/8/3QK3 w - - 0 1';
  const r = explainMove({
    fen,
    move: 'd1d5',
    analysis: {
      best: { move: 'd1d7', score: cp(900), pv: ['d1d7', 'e8f8'] },
      played: { move: 'd1d5', score: cp(-100), pv: ['d1d5', 'e6d5'] },
    },
  });
  assert.equal(r.quality, 'Blunder');
  assert.ok(r.motifs.includes('hangs-moved'), r.text);
  assert.equal(r.bestSan, 'Qd7+');
  assert.match(r.text, /Better was Qd7\+/);
});

test('Bb5 in the Ruy Lopez is development, not a pin (d7 pawn blocks)', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  const r = explainMove({
    fen,
    move: 'f1b5',
    analysis: {
      best: { move: 'f1b5', score: cp(35), pv: ['f1b5', 'a7a6'] },
      played: { move: 'f1b5', score: cp(35), pv: ['f1b5', 'a7a6'] },
    },
  });
  assert.equal(r.quality, 'Best');
  assert.ok(r.motifs.includes('develops'), r.text);
});

test('detects an absolute pin', () => {
  // After Bb5 the knight on d7 stands between the bishop and the king on e8.
  const fen = '4k3/3n4/8/8/8/8/8/4KB2 w - - 0 1';
  const r = explainMove({
    fen,
    move: 'f1b5',
    analysis: {
      best: { move: 'f1b5', score: cp(20), pv: ['f1b5'] },
      played: { move: 'f1b5', score: cp(20), pv: ['f1b5'] },
    },
  });
  assert.ok(r.motifs.includes('pin'), r.text);
  assert.match(r.text, /pins the knight on d7 to the king/);
});

test('detects a relative pin of the queen to the king', () => {
  // Black king a8, queen e8; Rh8 pins the queen against the king along the 8th rank.
  const fen = 'k3q3/8/1K6/8/8/8/8/7R w - - 0 1';
  const r = explainMove({
    fen,
    move: 'h1h8',
    analysis: {
      best: { move: 'h1h8', score: cp(800), pv: ['h1h8', 'e8h8'] },
      played: { move: 'h1h8', score: cp(800), pv: ['h1h8', 'e8h8'] },
    },
  });
  assert.ok(r.motifs.includes('pin'), r.text);
  assert.match(r.text, /pins the queen on e8 to the king/);
});

test('detects a king skewer', () => {
  // Ra8+ checks the king on d8; when it steps away, the rook on h8 falls.
  const fen = '3k3r/8/8/8/8/8/8/R3K3 w - - 0 1';
  const r = explainMove({
    fen,
    move: 'a1a8',
    analysis: {
      best: { move: 'a1a8', score: cp(500), pv: ['a1a8', 'd8e7', 'a8h8'] },
      played: { move: 'a1a8', score: cp(500), pv: ['a1a8', 'd8e7', 'a8h8'] },
    },
  });
  assert.ok(r.motifs.includes('skewer'), r.text);
});

test('detects allowing a back-rank mate', () => {
  // Black to move; king g8 behind f7/g7/h7 pawns, white rook on e1. ...a2?? allows Re8#.
  const fen = '6k1/5ppp/8/8/8/p7/5PPP/4R1K1 b - - 0 1';
  const r = explainMove({
    fen,
    move: 'a3a2',
    analysis: {
      best: { move: 'h7h6', score: cp(-500), pv: ['h7h6'] },
      played: { move: 'a3a2', score: mate(-1), pv: ['a3a2', 'e1e8'] },
    },
  });
  // Already -5, but walking into mate is still a blunder.
  assert.equal(r.quality, 'Blunder');
  assert.ok(r.motifs.includes('allows-back-rank-mate'), r.text);
  assert.equal(r.evalAfter, 'M1');
});

test('detects checkmate', () => {
  const fen = '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
  const r = explainMove({ fen, move: 'e1e8', analysis: null });
  assert.ok(r.motifs.includes('checkmate'));
  assert.equal(r.quality, null);
});

test('detects a discovered attack', () => {
  // The d3 knight blocks the b1 bishop's diagonal to the queen on h7; moving it reveals the attack.
  const fen = '4k3/7q/8/8/8/3N4/8/1B2K3 w - - 0 1';
  const r = explainMove({
    fen,
    move: 'd3f4',
    analysis: {
      best: { move: 'd3f4', score: cp(900), pv: ['d3f4'] },
      played: { move: 'd3f4', score: cp(900), pv: ['d3f4'] },
    },
  });
  assert.ok(r.motifs.includes('discovered-attack'), r.text);
});

test('works without an engine (template-only fallback)', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const r = explainMove({ fen, move: 'e2e4', analysis: null });
  assert.equal(r.san, 'e4');
  assert.equal(r.quality, null);
  assert.ok(r.motifs.includes('center'), r.text);
});
