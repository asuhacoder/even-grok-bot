#!/bin/bash
# Gate for the local ASR service. Starts the server through start.sh, proves it
# transcribes Japanese, proves it holds no non-loopback socket (audio stays on
# this machine), then stops it. Exit code 0 means every check passed.
set -uo pipefail

ASR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ASR_DIR/fixtures.sh"

PORT="${ASR_PORT:-8178}"
ENDPOINT="http://127.0.0.1:$PORT/inference"
mkdir -p "$ASR_DIR/bench-results"
FAILURES=0

check() {
  # check <description> <0 for pass, anything else for fail>
  if [[ "$2" == "0" ]]; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n' "$1"
    FAILURES=$((FAILURES + 1))
  fi
}

make_fixtures

"$ASR_DIR/start.sh" > "$ASR_DIR/bench-results/verify.server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

for _ in $(seq 1 120); do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then LISTENING=0; else LISTENING=1; fi
check "start.sh listens on 127.0.0.1:$PORT" "$LISTENING"

TRANSCRIPT=$(curl -sS "$ENDPOINT" \
  -F "file=@$FIXTURES/u1.wav" \
  -F "language=ja" \
  -F "response_format=json" \
  -F "temperature=0.0" \
  -F "temperature_inc=0.2" | python3 "$ASR_DIR/bench_lib.py" text)
echo "      transcript: $TRANSCRIPT"
if [[ -n "$TRANSCRIPT" && "$TRANSCRIPT" == *"プルリクエスト"* ]]; then TRANSCRIBED=0; else TRANSCRIBED=1; fi
check "u1.wav transcribes to the expected Japanese command" "$TRANSCRIBED"

# After serving a request the process should own only loopback sockets. A peer
# address that is not 127.0.0.1 would mean the audio left the machine.
NON_LOOPBACK=$(lsof -nP -a -p "$SERVER_PID" -i 2>/dev/null | awk 'NR>1 && $9 !~ /^127\.0\.0\.1:/' | wc -l | tr -d ' ')
echo "      non-loopback sockets: $NON_LOOPBACK"
if [[ "$NON_LOOPBACK" == "0" ]]; then OFFLINE=0; else OFFLINE=1; fi
check "no non-loopback socket on the server process" "$OFFLINE"

kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
sleep 0.5
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then STOPPED=1; else STOPPED=0; fi
check "server stopped, port $PORT free" "$STOPPED"

if [[ "$FAILURES" -ne 0 ]]; then
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
