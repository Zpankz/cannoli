#!/usr/bin/env bash
# Live run of one canvas with assertions: build → seed (resets Smoke/ and College/ canvases) →
# install → launch the isolated Obsidian → check the model is served → run-canvas.ts.
# Usage: CANVAS="College/1. Basics/1. Hello world.canvas" EXPECT=scripts/live/expect/hello-world.json \
#          CDP_PORT=9349 bash scripts/live/run-canvas.sh
# Env: SKIP_BUILD=1, SKIP_SEED=1 (keep the vault as is), plus everything run-canvas.ts reads
# (EXPECT_JSON, CMD, WAIT_FOR, RUN_TIMEOUT, SETTLE, SHOT). Leaves the instance running.
# Exit: 0 pass, 1 fail, 2 usage/setup error.
set -euo pipefail
source "$(dirname "$0")/env.sh"
[ -n "${CANVAS:-}" ] || { echo "usage: CANVAS=<vault path> [EXPECT=file.json] $0" >&2; exit 2; }

if [ -z "${SKIP_BUILD:-}" ]; then (cd "$LIVE_ROOT" && pnpm build) || exit 2; fi
if [ -z "${SKIP_SEED:-}" ]; then bun "$LIVE_SCRIPTS/seed-vault.ts" || exit 2; fi
"$LIVE_SCRIPTS/install-plugin.sh" || exit 2
"$LIVE_SCRIPTS/launch-isolated.sh" start || exit 2

data="$LIVE_VAULT/.obsidian/plugins/$PLUGIN_ID/data.json"
provider="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("llmProvider",""))' "$data")"
if [ "$provider" = "ollama" ]; then
  model="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ollamaModel"])' "$data")"
  curl -sf "http://127.0.0.1:11434/api/tags" | grep -qF "\"$model\"" || { echo "Ollama not serving model $model" >&2; exit 2; }
  echo "provider ollama, model $model"
fi

bun "$LIVE_SCRIPTS/run-canvas.ts"
