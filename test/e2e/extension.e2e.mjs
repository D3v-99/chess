// End-to-end: loads the unpacked extension in Chrome, maps www.chess.com to a local
// mock analysis board, simulates hovers and prints the tooltip text.
// Usage: node test/e2e/extension.e2e.mjs [--flip] [--llm] [/path]
import https from 'node:https';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const EXT = ROOT;
const TMP = fs.mkdtempSync('/tmp/cc-e2e-');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${TMP}/key.pem`, '-out', `${TMP}/cert.pem`, '-days', '1', '-subj', '/CN=www.chess.com'], { stdio: 'ignore' });
const FLIP = process.argv.includes('--flip');
const PATHNAME = process.argv.slice(2).find(a => a.startsWith('/')) || '/analysis';

// Scholar's-mate setup, Black to move (last move Qd1-f3 highlighted).
const placement = { a8:'br', c8:'bb', d8:'bq', e8:'bk', f8:'bb', g8:'bn', h8:'br', a7:'bp', b7:'bp', c7:'bp', d7:'bp', f7:'bp', g7:'bp', h7:'bp', c6:'bn', e5:'bp',
  c4:'wb', e4:'wp', f3:'wq', a2:'wp', b2:'wp', c2:'wp', d2:'wp', f2:'wp', g2:'wp', h2:'wp', a1:'wr', b1:'wn', c1:'wb', e1:'wk', g1:'wn', h1:'wr' };
const sqc = (sq) => `square-${sq.charCodeAt(0)-96}${sq[1]}`;
const pos = (sq) => { const f = sq.charCodeAt(0)-97, r = +sq[1]-1; const col = FLIP ? 7-f : f, row = FLIP ? r : 7-r; return `transform:translate(${col*100}%,${row*100}%)`; };
const pieces = Object.entries(placement).map(([sq,c]) => `<div class="piece ${c} ${sqc(sq)}" style="${pos(sq)}"></div>`).join('');
const hl = ['d1','f3'].map(sq => `<div class="highlight ${sqc(sq)}" style="${pos(sq)}"></div>`).join('');
const html = `<!doctype html><html><head><style>
body{margin:0;padding:40px} wc-chess-board{display:block;position:relative;width:640px;height:640px;background:#769656}
.piece,.highlight{position:absolute;left:0;top:0;width:12.5%;height:12.5%} .piece{background:rgba(0,0,0,.25);border-radius:50%}
.highlight{background:rgba(255,255,0,.4)}
</style></head><body><wc-chess-board class="board ${FLIP?'flipped':''}" id="board-analysis-board">${hl}${pieces}</wc-chess-board></body></html>`;

const server = https.createServer({ key: fs.readFileSync(`${TMP}/key.pem`), cert: fs.readFileSync(`${TMP}/cert.pem`) }, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
}).listen(8443);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, pipe: true, enableExtensions: [EXT],
  args: ['--no-sandbox', '--host-resolver-rules=MAP www.chess.com 127.0.0.1:8443', '--ignore-certificate-errors'],
});
const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
const sw = await swTarget.worker();
await sw.evaluate((llm) => chrome.storage.local.set(llm ? { acknowledged: true, llmProvider: 'ollama', model: 'deepseek-coder:latest' } : { acknowledged: true }), process.argv.includes('--llm'));

const page = await browser.newPage();
page.on('console', m => { if (!m.text().includes('favicon')) console.log('page console:', m.text()); });
await page.setViewport({ width: 1300, height: 800 });
await page.goto('https://www.chess.com' + PATHNAME);
await new Promise(r => setTimeout(r, 1500));

const client = await page.createCDPSession();
async function tipText() {
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const found = [];
  (function walk(n) { if (n.attributes) { const i = n.attributes.indexOf('class'); if (i >= 0 && /\bcc-tip\b/.test(n.attributes[i+1])) found.push(n); }
    for (const c of [...(n.children||[]), ...(n.shadowRoots||[])]) walk(c); })(root);
  if (!found.length) return '(no tooltip)';
  const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId: found[0].nodeId });
  if (/cc-tip[^>]*hidden/.test(outerHTML.slice(0, 120))) return '(hidden)';
  return outerHTML.replace(/<[^>]+>/g, ' | ').replace(/(\s*\|\s*)+/g, ' | ').trim();
}
async function dotCount() {
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  let n = 0; (function walk(x) { if (x.attributes) { const i = x.attributes.indexOf('class'); if (i >= 0 && /\bcc-dot\b/.test(x.attributes[i+1])) n++; }
    for (const c of [...(x.children||[]), ...(x.shadowRoots||[])]) walk(c); })(root); return n;
}
const center = (sq) => { const f = sq.charCodeAt(0)-97, r = +sq[1]-1; const col = FLIP ? 7-f : f, row = FLIP ? r : 7-r; return [40 + col*80 + 40, 40 + row*80 + 40]; };

const status = await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://www.chess.com/*' });
  return chrome.tabs.sendMessage(tab.id, { type: 'getPageStatus' });
});
console.log('PAGE STATUS:', JSON.stringify(status));

await page.mouse.move(...center('c6'));
await new Promise(r => setTimeout(r, 300));
console.log('HOVER c6 knight → dots:', await dotCount(), '\n  tip:', await tipText());

await page.mouse.move(...center('d4'), { steps: 3 });
await new Promise(r => setTimeout(r, process.argv.includes('--llm') ? 25000 : 4000));
console.log('HOVER d4 →\n  tip:', await tipText());

await page.mouse.move(...center('g8'), { steps: 3 });
await new Promise(r => setTimeout(r, 200));
await page.mouse.move(...center('f6'), { steps: 3 });
await new Promise(r => setTimeout(r, 4000));
console.log('HOVER g8→f6 →\n  tip:', await tipText());

await page.mouse.move(5, 5);
await new Promise(r => setTimeout(r, 300));
console.log('LEAVE board →', await tipText());
await browser.close(); server.close();
