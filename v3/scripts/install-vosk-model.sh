#!/usr/bin/env bash
set -euo pipefail

MODEL_NAME="${1:-vosk-model-en-us-0.22}"
MODEL_URL="${2:-https://alphacephei.com/vosk/models/${MODEL_NAME}.zip}"
FORCE="${FORCE:-0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOSK_DIR="$ROOT/Models/vosk"
TARGET_DIR="$VOSK_DIR/$MODEL_NAME"

if [ -d "$TARGET_DIR" ] && [ "$FORCE" != "1" ]; then
  echo "Vosk model already installed at $TARGET_DIR"
  exit 0
fi

mkdir -p "$VOSK_DIR"

TMP_DIR="$(mktemp -d)"
ZIP_PATH="$TMP_DIR/$MODEL_NAME.zip"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading $MODEL_NAME..."
if command -v curl >/dev/null 2>&1; then
  curl -fL "$MODEL_URL" -o "$ZIP_PATH"
else
  wget -O "$ZIP_PATH" "$MODEL_URL"
fi

if [ -d "$TARGET_DIR" ] && [ "$FORCE" = "1" ]; then
  rm -rf "$TARGET_DIR"
fi

echo "Extracting to $VOSK_DIR..."
unzip -q -o "$ZIP_PATH" -d "$VOSK_DIR"

if [ ! -d "$TARGET_DIR" ]; then
  echo "Expected model folder was not created: $TARGET_DIR" >&2
  exit 1
fi

echo "Installed Vosk model to $TARGET_DIR"
