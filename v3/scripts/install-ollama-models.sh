#!/usr/bin/env bash
set -euo pipefail

# Pull the local Gemma models that power Pythos's on-device brain.
#   gemma4:12b - default, best tool calling (~7.6 GB, 256K context)
#   gemma4:e2b - low-resource fallback for modest hardware (~1-2 GB)
#
# Requires Ollama: https://ollama.com/download  (macOS: brew install ollama)

DEFAULT_MODEL="${PYTHOS_OLLAMA_MODEL:-gemma4:12b}"
LOW_RESOURCE_MODEL="${PYTHOS_OLLAMA_LOW_RESOURCE_MODEL:-gemma4:e2b}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed. Install it from https://ollama.com/download" >&2
  echo "  macOS: brew install ollama" >&2
  exit 1
fi

# Make sure a server is reachable; start one in the background if not.
if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama server not reachable on 127.0.0.1:11434; starting 'ollama serve' in the background..."
  ollama serve >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "Pulling default model: ${DEFAULT_MODEL}"
ollama pull "${DEFAULT_MODEL}"

echo "Pulling low-resource model: ${LOW_RESOURCE_MODEL}"
ollama pull "${LOW_RESOURCE_MODEL}" || echo "Warning: could not pull ${LOW_RESOURCE_MODEL} (optional)."

echo "Done. Installed models:"
ollama list
