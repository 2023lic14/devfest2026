#!/usr/bin/env bash
set -euo pipefail

# Local dev bootstrap (installs Python + Node deps).
# Note: requires network access (pip/npm).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Python deps (api/.venv)"
cd "${ROOT_DIR}/api"
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt

echo "==> Python deps (audio)"
cd "${ROOT_DIR}"
pip install -r audio/requirements.txt

echo "==> Node deps (mcp/music-tools)"
cd "${ROOT_DIR}/mcp/music-tools"
npm ci
npm run build

echo "Done."
