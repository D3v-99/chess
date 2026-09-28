# Chess Coach Hover (educational)

A Manifest V3 Chrome extension that works like Grammarly for chess on **chess.com analysis boards**.
Hover over one of your pieces to see its legal moves, then hover over a destination square. A
tooltip shows how good that move is and why:

```
 Nd4                                   [Blunder]
 EVAL -0.1 → M1   BEST Nf6
 Nd4 is a blunder. This allows a forced mate in 1 (Qxf7#). Better was Nf6.
 Line: Nd4 Qxf7#
 Stockfish depth 14
 ───────────────────────────────────────────────
 Educational use only. Using this in rated games violates chess.com's Terms of Service.
```

> **Disclaimer:** This extension is for educational analysis only. Using it in rated games violates
> chess.com's Terms of Service. It never plays or suggests moves on its own. It stays inactive until
> you accept this disclaimer in the options page.

## Where it runs

| Page | Behaviour |
|---|---|
| `chess.com/analysis…` | Active |
| `chess.com/game/…` (finished games) | Off by default. With the **allow finished games** option on, it becomes active once a game-over indicator is present |
| `/play`, `/live`, `/daily`, `/puzzles`, `/puzzle-rush`, tournaments, arena, variants, bots | Always blocked |
| Any page where a running game clock is detected | Always blocked |

## Architecture

```
chess.com tab                         extension
┌──────────────────────┐   runtime    ┌───────────────────────┐  runtime  ┌────────────────────┐
│ content.js           │  messages    │ background.js (SW)    │ messages  │ offscreen.html/.js │
│ • find board (DOM)   │ ───────────▶ │ • validate FEN + move │ ────────▶ │  └─ Worker:        │
│ • pieces → FEN       │              │ • explain.js (rules)  │           │    engine-worker.js│
│ • flip / side-to-move│ ◀─────────── │ • llm.js (fetch)      │ ◀──────── │     └─ Worker:     │
│ • hover state machine│   result     │ • LLM cache/ratelimit │  scores   │       stockfish.js │
│ • Shadow-DOM tooltip │              └──────────┬────────────┘           │       (+ .wasm)    │
└──────────────────────┘                         │ fetch                  └────────────────────┘
                                                 ▼
                                OpenAI / DeepSeek / Ollama (optional)
```

**Why an offscreen document?** MV3 service workers cannot create Web Workers. The service worker
creates an offscreen document (`chrome.offscreen`, reason `WORKERS`), which hosts
`engine-worker.js`. That worker owns Stockfish as a nested worker, so nothing blocks a page's main
thread.

**Data flow for one hover:**

1. `content.js` watches the board with a `MutationObserver`. It reads `.piece` elements (for example
   `class="piece wn square-72"`) and builds a FEN. It works out:
   - **Side to move:** from the two last-move `.highlight` squares, falling back to the move list.
     You can override it in the popup.
   - **Board orientation:** geometrically, by comparing where pieces are drawn with their square
     class. The `flipped` class is the fallback.
   - **Castling rights:** from whether each king and rook is still on its home square.
   - **En passant:** from a highlighted two-square pawn push.
2. Hover over your own piece: its legal moves (chess.js) are drawn as dots in a Shadow-DOM overlay.
3. Hover over a highlighted square: after a 300 ms debounce, `{type:'analyzeMove', fen, move}` goes to
   the service worker.
4. `engine-worker.js` runs a **root search** (best move, eval, PV) and a **`searchmoves` search** for
   the move you're considering, at the same depth and time limit, so the two evals are comparable.
   If your move is the best move, it reuses the root search. Results are cached (LRU, 600 entries)
   and identical requests share one search. A newer hover **supersedes** older ones: queued work is
   dropped and an irrelevant running search is sent `stop`.
5. `lib/explain.js` rates the move from the drop in winning chances (the same logistic curve lichess
   uses):
   - Blunder: drop ≥ 0.3
   - Mistake: drop ≥ 0.2
   - Inaccuracy: drop ≥ 0.1
   - Walking into an avoidable forced mate is always a blunder.

   It then detects motifs on the board and along the PV: checkmate, hanging pieces, captures of
   undefended pieces, forks, absolute/relative pins, skewers, discovered attacks and checks, allowed
   forks/pins/skewers, allowed (back-rank) mates, material won or lost after the exchange settles,
   missed mates, and strategic notes (castling, development, centre, early queen, king walks,
   weakened pawn shield, open files, knights on the rim, passed pawns).
6. The tooltip renders straight away. If an LLM is configured, a second request asks for a 2–3
   sentence coaching explanation, which replaces the template text when it arrives. If the LLM
   fails, the template text stays and a short note explains why.

## File structure

```
manifest.json          MV3 manifest
background.js          service worker: routing, offscreen lifecycle, LLM cache + rate limit
offscreen.html/.js     hosts the engine worker (service workers can't spawn workers)
engine-worker.js       UCI driver: queue, supersede/stop, cache, info/bestmove parsing
content.js             board scraping → FEN, hover state machine, Shadow-DOM tooltip
styles.css             tooltip + move-dot styles (loaded inside the shadow root)
options.html/.js       settings: engine, hover, LLM provider/key/model/endpoint, disclaimer
popup.html/.js         on/off, side-to-move override, page + engine status, copy FEN
ui.css                 shared styles for options + popup
lib/chess.js           chess.js 1.4.0 (BSD-2), legal moves + SAN
lib/explain.js         classification + template motif detection (pure, unit-tested)
lib/llm.js             OpenAI / DeepSeek / Ollama clients + prompt
lib/settings.js        settings schema + provider defaults
stockfish/             Stockfish 19 lite single-threaded WASM (GPLv3)
scripts/fetch-stockfish.sh   (re)downloads the engine files
test/                  unit tests (node) + browser end-to-end tests (puppeteer-core)
```

## Setup

### 1. Get Stockfish (already included)

`stockfish/stockfish.js` and `stockfish/stockfish.wasm` are already included. This is the Stockfish
19 *lite, single-threaded* build (about 1.8 MB), which needs no cross-origin isolation. To download
them again:

```bash
npm run fetch-stockfish      # or: bash scripts/fetch-stockfish.sh
```

The files can also be downloaded manually from
<https://github.com/nmrugg/stockfish.js/releases/tag/v19.0.0>:
`stockfish-19-lite-single.js` → `stockfish/stockfish.js`, and
`stockfish-19-lite-single.wasm` → `stockfish/stockfish.wasm`. **Both files must share a base name**,
because the script finds the `.wasm` file by swapping its own extension.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. The options page opens automatically. Tick **"I understand…"** and click **Save settings**.
5. Open <https://www.chess.com/analysis>. Tabs that were already open get the script injected
   automatically; reload them if nothing happens.

### 3. Optional: configure an AI coach

Open the options page (right-click the toolbar icon → Options) and pick a provider:

| Provider | What you need | Default model / endpoint |
|---|---|---|
| OpenAI | API key from platform.openai.com | `gpt-4o-mini` · `https://api.openai.com/v1/chat/completions` |
| DeepSeek | API key from platform.deepseek.com | `deepseek-chat` · `https://api.deepseek.com/chat/completions` |
| Ollama | Ollama running locally, with a model pulled | `llama3.2` · `http://localhost:11434/api/generate` |

- **API keys:** stored only in `chrome.storage.local` and sent only to the provider's endpoint. They
  are never hardcoded, synced or logged.
- **Ollama:** by default Ollama **rejects requests from `chrome-extension://` origins with HTTP 403**.
  Start it with `OLLAMA_ORIGINS=chrome-extension://* ollama serve`. For a systemd install, run
  `sudo systemctl edit ollama`, add `Environment="OLLAMA_ORIGINS=chrome-extension://*"`, then restart
  Ollama. Use a general chat model (`llama3.2`, `qwen2.5:7b`, `mistral`); small coding models give
  poor chess commentary. On CPU, expect 10–30 s per explanation (the timeout is 60 s).
- **Custom or self-hosted endpoints** (any OpenAI-compatible server): enter the URL. Chrome asks for
  permission for that host when you save.
- **Test connection** saves your settings and sends a sample position to the provider.
- **Rate limiting:** LLM calls are serialized, spaced at least 1.2 s apart, and cached per position,
  move and model. After HTTP 429 the extension pauses LLM calls, using `Retry-After` if present or
  30 s otherwise, and uses template explanations in the meantime.

## Tests

```bash
npm test                 # unit tests for lib/explain.js (node --test, no deps)
npm install              # installs puppeteer-core (dev only) for the browser tests
npm run test:engine      # Stockfish worker + explain pipeline in headless Chrome under the extension CSP
npm run test:e2e         # loads the unpacked extension; hovers on a mock chess.com analysis board
node test/e2e/extension.e2e.mjs --flip           # same, with the board flipped
node test/e2e/extension.e2e.mjs /play/online     # must report "Disabled on play…"
```

The e2e tests need Chrome at `/usr/bin/google-chrome` (or set `CHROME_PATH`) and `openssl`.

### Manual testing checklist

- [ ] Fresh install opens the options page; nothing activates until the disclaimer is ticked.
- [ ] On `chess.com/analysis`, the popup says **Active**, shows the correct side to move, and its FEN
      matches the board (compare with chess.com's own FEN in Share → PGN/FEN).
- [ ] Hovering one of your pieces shows blue dots; captures show rings; the piece's square is outlined.
- [ ] Hovering a dot shows a spinner, then quality, eval (e.g. `-0.1 → M1`), best move, explanation and line.
- [ ] Hovering a known blunder (e.g. after `1.e4 e5 2.Bc4 Nc6 3.Qf3`, hover `...Nd4`) is rated **Blunder**
      and mentions `Qxf7#`.
- [ ] Sweeping the mouse from a piece to its destination across other pieces analyzes the right piece.
- [ ] Flip the board (chess.com's flip button): dots and tooltips still line up.
- [ ] Step through moves in the move list: the tooltip hides and the FEN updates each time.
- [ ] Hovering the same move again is instant (cached).
- [ ] Moving quickly across many squares doesn't queue up stale results.
- [ ] Popup toggle off: dots and tooltips disappear immediately. Toggle on: they come back.
- [ ] Side-to-move override (popup) changes which pieces respond to hover.
- [ ] `chess.com/play/online`, `/puzzles` and a live game: popup says **Inactive** with the reason.
- [ ] With an LLM configured, "AI coach is writing…" appears and is replaced by AI text.
- [ ] With a bad API key, the tooltip keeps the template text and notes "invalid API key".
- [ ] Temporarily rename `stockfish/stockfish.wasm`: the tooltip shows basic tactical checks with
      "Engine unavailable" and nothing crashes.
- [ ] Scrolling the page hides the tooltip; there are no console errors on chess.com.

## Known limitations

- **DOM-dependent:** chess.com changes its markup from time to time. Board and piece selectors are in
  `BOARD_SELECTORS` at the top of `content.js`, and the finished-game and clock detectors are
  listed alongside them. The clock and game-over selectors are best-effort: if they go stale, the
  extension fails *closed* on `/game/` pages (it stays off), but the running-clock guard on other
  pages may stop matching.
- **FEN guesses:** the DOM carries no move history, so castling rights are guessed from where kings
  and rooks stand (a king that moved and returned still looks like it can castle). The halfmove and
  fullmove counters are placeholders. If there is no last-move highlight or move list, the extension
  assumes White to move; use the popup override for set-up positions.
- **Promotions** are always analyzed as queen promotions.
- The **lite** Stockfish net is much weaker than full Stockfish, but still far stronger than any
  human. At depth 14 it is reliable for spotting blunders.
- **Template explanations are heuristic.** The motif detector ignores some subtleties, such as a
  pinned defender that can't really defend or x-ray attacks. The engine's verdict (quality and eval)
  is the ground truth.

## Licenses

- Stockfish.js: GPLv3 (`stockfish/COPYING.txt`). Because this package bundles Stockfish, distribute
  it under GPLv3.
- chess.js: BSD-2-Clause (`lib/chess.js.LICENSE`).
