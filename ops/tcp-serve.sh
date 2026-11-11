#!/bin/bash
set -euo pipefail
PROTO="${RELAY_RAW_PROXY_PROTOCOL:-2}"
TCP_PORT="${TAILSCALE_TCP_PORT:-8792}"
RAW_PORT="${RELAY_RAW_PORT:-8793}"
if [[ -z "${TAILSCALE_SOCKET+x}" ]]; then
  TAILSCALE_SOCKET=""
  [[ -e "$HOME/.tailscale/tailscaled.sock" ]] && TAILSCALE_SOCKET="$HOME/.tailscale/tailscaled.sock"
fi
case "$PROTO" in
  1|2|off) ;;
  *)
    echo "tcp-serve: RELAY_RAW_PROXY_PROTOCOL must be 1, 2, or off" >&2
    exit 1
    ;;
esac
TS=("${TAILSCALE_BIN:-tailscale}")
[[ -n "$TAILSCALE_SOCKET" ]] && TS+=(--socket "$TAILSCALE_SOCKET")
"${TS[@]}" serve --tcp="$TCP_PORT" off >/dev/null 2>&1 || true
if [[ "$PROTO" == off ]]; then
  "${TS[@]}" serve --bg --tcp="$TCP_PORT" "tcp://127.0.0.1:$RAW_PORT" >/dev/null
else
  "${TS[@]}" serve --bg --tcp="$TCP_PORT" --proxy-protocol="$PROTO" "tcp://127.0.0.1:$RAW_PORT" >/dev/null
fi
