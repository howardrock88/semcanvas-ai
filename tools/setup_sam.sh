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
CHECKPOINT="$MODEL_DIR/sam_vit_b_01ec64.pth"
CHECKPOINT_PART="$CHECKPOINT.part"
CHECKPOINT_URL="https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth"

cd "$ROOT"
if command -v uv >/dev/null 2>&1; then
  uv venv --python "$PYTHON_BIN" "$VENV_DIR"
else
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if "$VENV_DIR/bin/python" -m pip --version >/dev/null 2>&1; then
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install torch torchvision opencv-python-headless segment-anything
elif command -v uv >/dev/null 2>&1; then
  uv pip install --python "$VENV_DIR/bin/python" torch torchvision opencv-python-headless segment-anything
else
  "$VENV_DIR/bin/python" -m ensurepip --upgrade
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install torch torchvision opencv-python-headless segment-anything
fi

mkdir -p "$MODEL_DIR"
if [[ ! -f "$CHECKPOINT" ]]; then
  rm -f "$CHECKPOINT_PART"
  curl -L "$CHECKPOINT_URL" -o "$CHECKPOINT_PART"
  mv "$CHECKPOINT_PART" "$CHECKPOINT"
fi

cat <<EOF
SAM setup complete.

Start the app with:
  SEGMENT_BACKEND=sam npm start

Or let the server use SAM automatically when the venv and checkpoint exist:
  npm start
EOF
