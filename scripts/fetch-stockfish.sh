#!/usr/bin/env bash
# Downloads Stockfish 19 "lite single-threaded" WASM build (GPLv3) into ./stockfish/
# as stockfish.js + stockfish.wasm. The .js locates the .wasm by replacing its own
# extension, so both files must keep matching names and sit side by side.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0"
mkdir -p stockfish
if command -v npm >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack stockfish@19.0.0 >/dev/null && tar xzf stockfish-19.0.0.tgz)
  cp "$tmp/package/bin/stockfish-19-lite-single.js" stockfish/stockfish.js
  cp "$tmp/package/bin/stockfish-19-lite-single.wasm" stockfish/stockfish.wasm
  cp "$tmp/package/Copying.txt" stockfish/COPYING.txt
  rm -rf "$tmp"
else
  curl -fL "$BASE/stockfish-19-lite-single.js" -o stockfish/stockfish.js
  curl -fL "$BASE/stockfish-19-lite-single.wasm" -o stockfish/stockfish.wasm
fi
ls -la stockfish
echo "Stockfish ready."
