#!/usr/bin/env bash
# End-to-end live smoke: build → seed → install → launch → open Smoke/hello.canvas →
# run "cannoli:start" → wait for the output node in the .canvas file to get text → screenshot.
# Leaves the isolated instance running. Env: SKIP_BUILD=1, CANVAS=Smoke/hello.canvas,
# OUTPUT_NODE=output, SMOKE_TIMEOUT=240 (seconds).
set -euo pipefail
source "$(dirname "$0")/env.sh"
canvas="${CANVAS:-Smoke/hello.canvas}"
out_node="${OUTPUT_NODE:-output}"
timeout="${SMOKE_TIMEOUT:-240}"
mkdir -p "$LIVE_SHOTS"

if [ -z "${SKIP_BUILD:-}" ]; then (cd "$LIVE_ROOT" && pnpm build); fi
bun "$LIVE_SCRIPTS/seed-vault.ts"
"$LIVE_SCRIPTS/install-plugin.sh"
"$LIVE_SCRIPTS/launch-isolated.sh" start

model="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ollamaModel"])' "$LIVE_VAULT/.obsidian/plugins/$PLUGIN_ID/data.json")"
curl -sf "http://127.0.0.1:11434/api/tags" | grep -qF "\"$model\"" || { echo "Ollama not serving model $model" >&2; exit 1; }

# The start command acts on the active file, so open the canvas first.
OPEN="$canvas" CMD="$PLUGIN_ID:start" cdp

output_text() {
  python3 - "$LIVE_VAULT/$canvas" "$out_node" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
print(next((n.get("text", "") for n in d["nodes"] if n["id"] == sys.argv[2]), ""))
EOF
}
deadline=$((SECONDS + timeout)); text=""
while [ $SECONDS -lt $deadline ]; do
  running="$(cdp -e "return Object.keys(app.plugins.plugins['$PLUGIN_ID']?.runningCannolis ?? {}).length" 2>/dev/null || echo 1)"
  text="$(output_text)"
  [ -n "$text" ] && [ "$running" = "0" ] && break
  sleep 2
done

shot="$LIVE_SHOTS/smoke-$(date +%Y%m%d-%H%M%S).png"
SHOT="$shot" cdp -e 'return [...document.querySelectorAll(".notice")].map(n => n.textContent)'
echo "screenshot: $shot"
if [ -z "$text" ]; then echo "SMOKE FAIL: output node '$out_node' in $canvas is empty after ${timeout}s" >&2; exit 1; fi
printf 'SMOKE OK (%s, model %s). output node text:\n%s\n' "$canvas" "$model" "$text"
echo "instance pid=$(live_pid) port=$CDP_PORT"
