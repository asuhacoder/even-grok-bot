#!/bin/bash
# Local Japanese ASR server for even-grok-bot. Inference stays on this machine:
# the socket binds the loopback address and nothing in this path opens a network connection.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/vendor/whisper.cpp/build/bin/whisper-server"
MODELS="$ROOT/vendor/models"

HOST="${ASR_HOST:-127.0.0.1}"
PORT="${ASR_PORT:-8178}"
MODEL="${ASR_MODEL:-ggml-large-v3-turbo-q5_0.bin}"
VAD_MODEL="${ASR_VAD_MODEL:-ggml-silero-v5.1.2.bin}"
# 6 threads tracks the 5 performance cores of an M5 Pro; Metal does the heavy matmuls.
THREADS="${ASR_THREADS:-6}"
VAD="${ASR_VAD:-1}"
if [ -n "${ASR_PROMPT+x}" ]; then
  PROMPT="$ASR_PROMPT"
else
  PROMPT="開発PM、サンプル、Slack"
fi

for required in "$BIN" "$MODELS/$MODEL"; do
  if [[ ! -e "$required" ]]; then
    echo "asr: missing $required (see asr/README.md for the build and download steps)" >&2
    exit 1
  fi
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "asr: $HOST:$PORT is already listening, leaving the running instance alone" >&2
  exit 0
fi

OPTIONAL_ARGS=""
if [[ "$VAD" == "1" && -e "$MODELS/$VAD_MODEL" ]]; then
  OPTIONAL_ARGS="--vad -vm $MODELS/$VAD_MODEL"
fi
if [[ -n "$PROMPT" ]]; then
  OPTIONAL_ARGS="$OPTIONAL_ARGS --prompt $PROMPT"
fi

# Model paths contain no spaces, so unquoted word-splitting is safe here and keeps
# the script compatible with the bash 3.2 that ships on macOS.
# shellcheck disable=SC2086
exec "$BIN" \
  --host "$HOST" \
  --port "$PORT" \
  --model "$MODELS/$MODEL" \
  --language ja \
  --threads "$THREADS" \
  --flash-attn \
  $OPTIONAL_ARGS
