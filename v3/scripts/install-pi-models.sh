#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/.pi/models.json"
TARGET_DIR="$HOME/.pi/agent"
TARGET="$TARGET_DIR/models.json"

mkdir -p "$TARGET_DIR"
cp -f "$SOURCE" "$TARGET"
echo "Installed Pi Gemini model config to $TARGET"
