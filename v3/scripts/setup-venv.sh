#!/usr/bin/env bash
set -euo pipefail

# Move to the v3 project root (parent of this scripts directory).
cd "$(dirname "$0")/.."

# PyAudio needs the PortAudio native library. On macOS install it with Homebrew:
#   brew install portaudio
# On Debian/Ubuntu:
#   sudo apt-get install -y portaudio19-dev
if [[ "$(uname)" == "Darwin" ]] && ! brew list portaudio >/dev/null 2>&1; then
  echo "Warning: PortAudio not found via Homebrew. Run 'brew install portaudio' if PyAudio fails to build." >&2
fi

PYTHON_BIN="${PYTHON_BIN:-python3}"

if [ ! -d ".venv" ]; then
  "$PYTHON_BIN" -m venv .venv
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
