#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install Node.js first." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js/npm first." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

npm install

if ! command -v codex >/dev/null 2>&1; then
  cat >&2 <<'WARN'
Warning: codex CLI was not found.
The default image provider is Codex CLI. Install and log in to Codex before generating images, or configure OpenAI/custom API in .env or the UI.
WARN
fi

bash tools/setup_fastsam.sh

cat <<'NEXT'
Local setup complete.

Start manually:
  npm start

Or install the macOS background service:
  npm run service:install
NEXT
