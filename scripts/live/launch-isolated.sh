#!/usr/bin/env bash
# Isolated Obsidian for live Cannoli tests: own --user-data-dir and test vault under
# .scratch/live, CDP on port 9346. Never touches the main Obsidian or real vaults.
# Usage: launch-isolated.sh [start|quit|status]   (start is idempotent)
set -euo pipefail
source "$(dirname "$0")/env.sh"
mode="${1:-start}"

# True if pid is our isolated instance. Case-insensitive: macOS paths are case-insensitive,
# and the argv spelling depends on how the launching shell spelled the worktree path.
owns_instance() {
  ps -o command= -p "$1" 2>/dev/null | tr '[:upper:]' '[:lower:]' |
    grep -qF -- "$(printf '%s' "--user-data-dir=$LIVE_USERDATA" | tr '[:upper:]' '[:lower:]')"
}

case "$mode" in
  status)
    pid="$(live_pid)"
    if [ -n "$pid" ]; then echo "running pid=$pid port=$CDP_PORT"; else echo "not running (port $CDP_PORT)"; exit 1; fi
    ;;
  quit)
    pid="$(live_pid)"
    [ -z "$pid" ] && { echo "not running (port $CDP_PORT)"; exit 0; }
    # Only stop the process that owns our port AND our user-data dir.
    if ! owns_instance "$pid"; then
      echo "pid $pid on port $CDP_PORT is not the isolated instance; refusing to stop it" >&2; exit 1
    fi
    kill -TERM "$pid"
    for _ in $(seq 1 50); do [ -z "$(live_pid)" ] && { echo "stopped pid=$pid"; exit 0; }; sleep 0.2; done
    echo "pid $pid still listening after 10s" >&2; exit 1
    ;;
  start)
    if pid="$(live_pid)" && [ -n "$pid" ]; then
      if owns_instance "$pid"; then
        echo "already running pid=$pid port=$CDP_PORT"; exit 0
      fi
      echo "port $CDP_PORT is held by another process (pid $pid); not launching" >&2; exit 1
    fi
    [ -d "$LIVE_VAULT/.obsidian" ] || { echo "no vault at $LIVE_VAULT; run seed-vault.ts first" >&2; exit 1; }
    mkdir -p "$LIVE_USERDATA"
    # Register only the test vault and mark it open, so Obsidian opens it directly
    # (an obsidian:// URL would be routed to the user's main Obsidian instead).
    printf '{"vaults":{"%s":{"path":"%s","ts":%s,"open":true}},"updateDisabled":true}\n' \
      "$LIVE_VAULT_ID" "$LIVE_VAULT" "$(($(date +%s) * 1000))" > "$LIVE_USERDATA/obsidian.json"
    # Backgrounded (-g) windows can start occluded; Chromium then throttles timers and
    # rendering, which stalls CDP evals. These flags keep it live.
    open -n -g -a Obsidian --args --user-data-dir="$LIVE_USERDATA" \
      --remote-debugging-port="$CDP_PORT" --remote-debugging-address=127.0.0.1 \
      --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
      --disable-background-timer-throttling
    for _ in $(seq 1 100); do
      curl -sf "http://127.0.0.1:$CDP_PORT/json/list" 2>/dev/null | grep -qF 'app://obsidian.md/index.html' && break
      sleep 0.3
    done
    T=30000 cdp -e 'for (let i = 0; i < 100 && !(window.app?.workspace?.layoutReady); i++) await new Promise(r => setTimeout(r, 200)); return { ready: !!app?.workspace?.layoutReady, vault: app?.vault?.getName?.() };' >/dev/null
    # Leave restricted mode, accept the vault-trust prompt and (re)load the plugin.
    ENABLE=1 cdp -e 'return Object.keys(app.plugins.plugins)'
    echo "started pid=$(live_pid) port=$CDP_PORT vault=$LIVE_VAULT"
    ;;
  *) echo "usage: $0 [start|quit|status]" >&2; exit 2 ;;
esac
