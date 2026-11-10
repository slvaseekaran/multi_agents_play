#!/usr/bin/env bash
# Creates the backend's Python environment inside WSL (FastAPI needs Python >= 3.9; uv fetches one if needed).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../backend"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
[ -x "$UV" ] || { echo "uv not found. Install it inside WSL:  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2; exit 1; }
[ -x .venv/bin/python ] || "$UV" venv --python 3.12 .venv
"$UV" pip install --python .venv/bin/python -r requirements.txt
command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || echo "WARNING: the 'claude' CLI was not found in WSL." >&2
.venv/bin/python -c "import fastapi, uvicorn; print('backend ready: fastapi', fastapi.__version__)"
