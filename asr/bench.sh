#!/bin/bash
# Benchmark the local ASR server: cold and warm latency, WAV vs raw-PCM-wrapped input.
# Run: asr/bench.sh                      the default model (large-v3-turbo q5_0)
#      ASR_MODEL=ggml-large-v3-turbo-q8_0.bin asr/bench.sh
#      PROMPT="開発PM、サンプル、Slack" asr/bench.sh
#      ASR_VAD=0 asr/bench.sh                                 with VAD disabled
# Writes asr/bench-results/<tag>.tsv, <tag>.jsonl and <tag>.meta.json, then stops the server it started.
set -euo pipefail

ASR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ASR_DIR/fixtures.sh"

PORT="${ASR_PORT:-8178}"
ENDPOINT="http://127.0.0.1:$PORT/inference"
RESULTS="$ASR_DIR/bench-results"
WARM_REPS="${WARM_REPS:-3}"
MODEL="${ASR_MODEL:-ggml-large-v3-turbo-q5_0.bin}"
PROMPT="${PROMPT:-}"
VAD="${ASR_VAD:-1}"
SERVER_PID=""

# Prompt text is folded into the tag as a short hash so two prompt variants never overwrite each other.
PROMPT_TAG=""
if [[ -n "$PROMPT" ]]; then
  PROMPT_TAG="-prompt$(printf '%s' "$PROMPT" | shasum | cut -c1-6)"
fi
TAG="${MODEL%.bin}$PROMPT_TAG$([[ "$VAD" == "1" ]] || echo -novad)"

mkdir -p "$RESULTS"
TSV="$RESULTS/$TAG.tsv"
JSONL="$RESULTS/$TAG.jsonl"
SERVER_LOG="$RESULTS/$TAG.server.log"

start_server() {
  local spawned_at
  spawned_at=$(date +%s)
  ASR_MODEL="$MODEL" ASR_VAD="$VAD" ASR_PROMPT="$PROMPT" "$ASR_DIR/start.sh" > "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      MODEL_LOAD_S=$(( $(date +%s) - spawned_at ))
      return 0
    fi
    sleep 0.5
  done
  echo "server never listened on $PORT, see $SERVER_LOG" >&2
  tail -20 "$SERVER_LOG" >&2
  exit 1
}

stop_server() {
  if [[ -z "$SERVER_PID" ]]; then
    return 0
  fi
  # start.sh execs the server, so this pid is the server itself.
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

post() {
  # post <wav> -> "<latency_ms>\n<transcript>"
  local response="$RESULTS/.response.json"
  local seconds transcript
  local prompt_field=()
  if [[ -n "$PROMPT" ]]; then
    prompt_field=(-F "prompt=$PROMPT")
  fi
  # ${arr[@]+...} keeps an empty array from tripping `set -u` on the bash 3.2 that ships on macOS.
  seconds=$(curl -sS -o "$response" -w '%{time_total}' "$ENDPOINT" \
    -F "file=@$1" \
    -F "language=ja" \
    -F "response_format=json" \
    -F "temperature=0.0" \
    -F "temperature_inc=0.2" \
    ${prompt_field[@]+"${prompt_field[@]}"})
  transcript=$(python3 "$ASR_DIR/bench_lib.py" text < "$response")
  python3 -c 'import sys; print(f"{float(sys.argv[1])*1000:.0f}")' "$seconds"
  printf '%s\n' "$transcript"
}

record() {
  # record <pass> <utterance-id> <input-kind> <audio-file> <latency_ms> <transcript>
  local pass=$1 id=$2 kind=$3 file=$4 latency=$5 transcript=$6
  local reference cer audio_seconds bytes
  reference=$(< "$FIXTURES/$id.txt")
  cer=$(python3 "$ASR_DIR/bench_lib.py" cer "$reference" "$transcript")
  audio_seconds=$(python3 -c '
import sys, wave
with wave.open(sys.argv[1]) as w:
    print(f"{w.getnframes()/w.getframerate():.2f}")' "$file")
  bytes=$(stat -f%z "$file")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$pass" "$id" "$kind" "$audio_seconds" "$bytes" "$latency" "$cer" "$transcript" >> "$TSV"
  python3 -c '
import json, sys
print(json.dumps({"pass": sys.argv[1], "utterance": sys.argv[2], "input": sys.argv[3],
                  "audio_s": float(sys.argv[4]), "latency_ms": int(sys.argv[5]),
                  "cer": float(sys.argv[6]), "reference": sys.argv[7],
                  "transcript": sys.argv[8]}, ensure_ascii=False))' \
    "$pass" "$id" "$kind" "$audio_seconds" "$latency" "$cer" "$reference" "$transcript" >> "$JSONL"
}

main() {
  make_fixtures
  : > "$TSV"
  : > "$JSONL"
  printf 'pass\tutterance\tinput\taudio_s\tbytes\tlatency_ms\tcer\ttranscript\n' >> "$TSV"

  start_server

  # Cold: the very first inference after model load, before Metal kernels are warm.
  local out
  out=$(post "$FIXTURES/u1.wav")
  record cold u1 wav "$FIXTURES/u1.wav" "$(sed -n 1p <<<"$out")" "$(sed -n 2p <<<"$out")"

  local id kind file rep
  for index in $(seq 1 "${#SENTENCES[@]}"); do
    id="u$index"
    for kind in wav pcm pcm100; do
      case "$kind" in
        wav) file="$FIXTURES/$id.wav" ;;
        pcm) file="$FIXTURES/$id.pcm.wav" ;;
        pcm100) file="$FIXTURES/$id.pcm100.wav" ;;
      esac
      for rep in $(seq 1 "$WARM_REPS"); do
        out=$(post "$file")
        record warm "$id" "$kind" "$file" "$(sed -n 1p <<<"$out")" "$(sed -n 2p <<<"$out")"
      done
    done
  done

  stop_server
  python3 - "$RESULTS/$TAG.meta.json" "$MODEL" "$VAD" "$PROMPT" "$WARM_REPS" "$MODEL_LOAD_S" <<'PYMETA'
import json, sys
path, model, vad, prompt, reps, load_s = sys.argv[1:]
json.dump({"model": model, "vad": vad == "1", "prompt": prompt,
           "warm_reps": int(reps), "model_load_s": int(load_s)},
          open(path, "w"))
PYMETA
  echo "wrote $TSV, $JSONL and $RESULTS/$TAG.meta.json"
}

trap 'stop_server' EXIT
main
