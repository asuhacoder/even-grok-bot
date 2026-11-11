#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$ROOT/g2" && node_modules/.bin/vite build >/dev/null)
PLIST="$HOME/Library/LaunchAgents/dev.evengrok.relay.plist"
if [[ -f "$PLIST" ]]; then
  eval "$(python3 - "$PLIST" << 'PY'
import plistlib, shlex, sys
env = plistlib.load(open(sys.argv[1], "rb")).get("EnvironmentVariables", {})
for key in ("RELAY_RAW_PROXY_PROTOCOL", "TAILSCALE_BIN", "TAILSCALE_SOCKET", "TAILSCALE_TCP_PORT", "RELAY_RAW_PORT"):
    value = env.get(key)
    if isinstance(value, str) and value:
        print(f"export {key}={shlex.quote(value)}")
PY
)"
fi
if [[ -z "${TAILSCALE_SOCKET+x}" ]]; then
  TAILSCALE_SOCKET=""
  [[ -e "$HOME/.tailscale/tailscaled.sock" ]] && TAILSCALE_SOCKET="$HOME/.tailscale/tailscaled.sock"
fi
export TAILSCALE_SOCKET
TS=("${TAILSCALE_BIN:-tailscale}")
[[ -n "$TAILSCALE_SOCKET" ]] && TS+=(--socket "$TAILSCALE_SOCKET")
"$ROOT/ops/tcp-serve.sh"
TCP_PORT="${TAILSCALE_TCP_PORT:-8792}"
IP="$("${TS[@]}" ip -4)"
echo "Packaged app WebSocket: ws://$IP:$TCP_PORT/ws"
echo "Token file (do not commit): $ROOT/relay/state/token"
exec "$ROOT/g2/node_modules/.bin/evenhub" qr --url "http://$IP:$TCP_PORT/app/index.html?token=$(cat "$ROOT/relay/state/token")" "$@"
