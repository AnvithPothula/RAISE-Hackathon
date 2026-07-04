#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -x ".venv/bin/python" ]; then
  .venv/bin/python -m pytest
else
  python3 -m pytest
fi

npm test
