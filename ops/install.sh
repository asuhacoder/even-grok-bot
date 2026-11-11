#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs/even-grok" "$AGENTS"
export NODE_BIN="$(command -v node)"
export ROOT
export RELAY_PORT="${RELAY_PORT:-8791}"
export RELAY_RAW_PORT="${RELAY_RAW_PORT:-8793}"
export TAILSCALE_TCP_PORT="${TAILSCALE_TCP_PORT:-8792}"
export ASR_PORT="${ASR_PORT:-8178}"
export RELAY_OWNER_LOGIN="${RELAY_OWNER_LOGIN:-}"
export RELAY_RAW_PROXY_PROTOCOL="${RELAY_RAW_PROXY_PROTOCOL:-2}"
if [[ -z "${TAILSCALE_SOCKET+x}" ]]; then
  TAILSCALE_SOCKET=""
  [[ -e "$HOME/.tailscale/tailscaled.sock" ]] && TAILSCALE_SOCKET="$HOME/.tailscale/tailscaled.sock"
fi
export TAILSCALE_SOCKET
export TAILSCALE_BIN="${TAILSCALE_BIN:-$(command -v tailscale || true)}"
export GROK_APP="${GROK_APP:-}"
case "$RELAY_RAW_PROXY_PROTOCOL" in
  1|2|off) ;;
  *)
    echo "install: RELAY_RAW_PROXY_PROTOCOL must be 1, 2, or off" >&2
    exit 1
    ;;
esac
if [[ "$RELAY_RAW_PROXY_PROTOCOL" != off && -z "$TAILSCALE_BIN" ]]; then
  echo "install: tailscale was not found on PATH" >&2
  exit 1
fi
render() {
  python3 - "$1" "$2" << 'PY'
import os, pathlib, sys
src, dest = sys.argv[1], sys.argv[2]
text = pathlib.Path(src).read_text()
for key, value in {
    "__NODE__": os.environ["NODE_BIN"],
    "__ROOT__": os.environ["ROOT"],
    "__HOME__": os.environ["HOME"],
    "__RELAY_PORT__": os.environ["RELAY_PORT"],
    "__RELAY_RAW_PORT__": os.environ["RELAY_RAW_PORT"],
    "__OWNER_LOGIN__": os.environ.get("RELAY_OWNER_LOGIN", ""),
    "__RAW_PROXY__": os.environ["RELAY_RAW_PROXY_PROTOCOL"],
    "__TAILSCALE_BIN__": os.environ["TAILSCALE_BIN"],
    "__TAILSCALE_SOCKET__": os.environ["TAILSCALE_SOCKET"],
    "__ASR_PORT__": os.environ["ASR_PORT"],
    "__GROK_APP__": os.environ.get("GROK_APP", ""),
}.items():
    text = text.replace(key, value)
pathlib.Path(dest).write_text(text)
PY
}
lint_plist() {
  python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$1"
}
load_agent() {
  local src="$1"
  local label dest staged prev
  label="$(basename "$src" .plist)"
  dest="$AGENTS/$label.plist"
  staged="$(mktemp)"
  render "$src" "$staged"
  if ! lint_plist "$staged"; then
    rm -f "$staged"
    echo "install: $label plist is invalid, leaving the running job untouched" >&2
    exit 1
  fi
  prev=""
  if [[ -f "$dest" ]]; then
    prev="$(mktemp)"
    cp "$dest" "$prev"
  fi
  mv "$staged" "$dest"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$(id -u)" "$dest"; then
    echo "install: failed to load $label" >&2
    if [[ -n "$prev" ]]; then
      cp "$prev" "$dest"
      launchctl bootstrap "gui/$(id -u)" "$dest" || true
    fi
    rm -f "$prev"
    exit 1
  fi
  rm -f "$prev"
  echo "loaded $label"
}
for plist in "$ROOT/asr/dev.evengrok.asr.plist" "$ROOT/ops/dev.evengrok.relay.plist"; do
  load_agent "$plist"
done
TS=("${TAILSCALE_BIN:-tailscale}")
[[ -n "$TAILSCALE_SOCKET" ]] && TS+=(--socket "$TAILSCALE_SOCKET")
"${TS[@]}" serve --bg --https=443 --set-path /evengrok "http://127.0.0.1:$RELAY_PORT" >/dev/null
"$ROOT/ops/tcp-serve.sh"
echo "tailnet: https://$("${TS[@]}" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/evengrok/ws"
echo "raw tcp: ws://$("${TS[@]}" ip -4):$TAILSCALE_TCP_PORT/ws"
