# Shared paths for the live harness; sourced by the other scripts/live/*.sh.
# Everything mutable lives under <repo>/.scratch/live (git-ignored).
LIVE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIVE_DIR="${CANNOLI_LIVE_DIR:-$LIVE_ROOT/.scratch/live}"
LIVE_VAULT="$LIVE_DIR/vault"
LIVE_USERDATA="$LIVE_DIR/obsidian-userdata"
LIVE_SHOTS="$LIVE_DIR/shots"
LIVE_SCRIPTS="$LIVE_ROOT/scripts/live"
CDP_PORT="${CDP_PORT:-9346}"
# Vault id in obsidian.json (also keys Obsidian's per-vault localStorage).
LIVE_VAULT_ID="cannolilive0test"
PLUGIN_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$LIVE_ROOT/manifest.json")"
export CDP_PORT

case "$CDP_PORT" in
  9333|9334|9335|9336|9337|9338|9339|9340|9342)
    echo "refusing CDP port $CDP_PORT: reserved for other Obsidian instances" >&2; exit 2 ;;
esac

# PID of the process listening on our CDP port (empty if none).
live_pid() { lsof -tiTCP:"$CDP_PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

# Bun runner for the CDP helpers.
cdp() { bun "$LIVE_SCRIPTS/cdp-eval.ts" "$@"; }
