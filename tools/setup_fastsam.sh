#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if command -v python3.11 >/dev/null 2>&1; then
    PYTHON_BIN="python3.11"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    echo "Python 3 is required. Install Python 3.11+ or set PYTHON_BIN=/path/to/python." >&2
    exit 1
  fi
fi
VENV_DIR="$ROOT/.venv-seg"
MODEL_DIR="$ROOT/models"
MODEL="$MODEL_DIR/FastSAM-s.pt"
MODEL_PART="$MODEL.part"
MODEL_URL="https://github.com/ultralytics/assets/releases/download/v8.4.0/FastSAM-s.pt"

cd "$ROOT"
if command -v uv >/dev/null 2>&1; then
  uv venv --python "$PYTHON_BIN" "$VENV_DIR"
  uv pip install --python "$VENV_DIR/bin/python" torch torchvision ultralytics
else
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  "$VENV_DIR/bin/python" -m ensurepip --upgrade
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install torch torchvision ultralytics
fi

mkdir -p "$MODEL_DIR"
if [[ ! -f "$MODEL" ]]; then
  rm -f "$MODEL_PART"
  curl -L "$MODEL_URL" -o "$MODEL_PART"
  mv "$MODEL_PART" "$MODEL"
fi

cat <<EOF
FastSAM setup complete.

Start the app with:
  SEGMENT_BACKEND=fastsam npm start

Or let the server use FastSAM automatically when the model exists:
  npm start
EOF
