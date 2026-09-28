// Runs engine-worker.js + Stockfish + explain.js in headless Chrome under the extension's CSP.
// Usage: node test/e2e/engine.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const testJs = `
import { explainMove } from '/lib/explain.js';
const w = new Worker('/engine-worker.js');
let id = 0; const pend = new Map(); const statuses = [];
w.onmessage = ({data}) => { if (data.type==='status') statuses.push(data.state); else pend.get(data.id)?.(data); };
const call = (m) => new Promise(r => { const i=++id; pend.set(i, r); w.postMessage({...m, id:i}); });
const out = { statuses };
const t0 = performance.now();
// Scholar's-mate setup: White to move, Qxf7# available. Try the blunder Qf3-e3?? style alternative too.
const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
// Black to move: Nd4?? allows Qxf7#; Nf6 defends.
const a = await call({type:'analyze', fen, move:'c6d4', depth:12, movetime:1500});
out.analyzeMs = Math.round(performance.now()-t0);
out.a = a;
out.explainA = a.ok ? explainMove({fen, move:'c6d4', analysis:a.data}) : null;
const t1 = performance.now();
const b = await call({type:'analyze', fen, move:'c6d4', depth:12, movetime:1500});
out.cachedMs = Math.round(performance.now()-t1);
// Supersede test: fire two requests, first should be superseded
const p1 = call({type:'analyze', fen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', move:'g1h3', depth:22, movetime:5000});
const p2 = call({type:'analyze', fen, move:'g8f6', depth:10, movetime:1000});
out.super1 = await p1; out.super2ok = (await p2).ok;
out.explainB = explainMove({fen, move:'g8f6', analysis:(await p2).data});
await fetch('/done', {method:'POST', body: JSON.stringify(out)});
`;
const page = '<!doctype html><script type="module" src="/__test.js"></script>';
const server = http.createServer((req, res) => {
  const csp = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
  if (req.url === '/') { res.writeHead(200, {'content-type':'text/html','content-security-policy':csp}); return res.end(page); }
  if (req.url === '/__test.js') { res.writeHead(200, {'content-type':'text/javascript','content-security-policy':csp}); return res.end(testJs); }
  if (req.url === '/done') { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ res.end('ok'); console.log(JSON.stringify(JSON.parse(b), null, 1)); done(); }); return; }
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0].split('#')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'content-security-policy': csp});
  fs.createReadStream(f).pipe(res);
});
let done;
const finished = new Promise(r => done = r);
server.listen(8765);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const p = await browser.newPage();
p.on('console', m => console.log('console:', m.text()));
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.goto('http://localhost:8765/');
const timer = setTimeout(() => { console.log('TIMEOUT'); done(); }, 60000);
await finished;
clearTimeout(timer);
await browser.close(); server.close();
