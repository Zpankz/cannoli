#!/usr/bin/env bash
# End-to-end live smoke, a thin wrapper over run-canvas.sh: build → seed → install → launch →
# open Smoke/hello.canvas → run "cannoli:start" → expect the run to complete with the output
# node filled → screenshot. Leaves the isolated instance running.
# Env: SKIP_BUILD=1, CANVAS=Smoke/hello.canvas, OUTPUT_NODE=output, SMOKE_TIMEOUT=240 (seconds),
# SHOT=<png path> (default .scratch/live/shots/smoke-<time>.png).
set -euo pipefail
source "$(dirname "$0")/env.sh"
export CANVAS="${CANVAS:-Smoke/hello.canvas}"
out_node="${OUTPUT_NODE:-output}"
export RUN_TIMEOUT="${SMOKE_TIMEOUT:-240}"
export SHOT="${SHOT:-$LIVE_SHOTS/smoke-$(date +%Y%m%d-%H%M%S).png}"
export EXPECT_JSON="{\"run\":\"complete\",\"nodes\":[{\"node\":$(printf '%s' "$out_node" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),\"textMatches\":\"\\\\S\"}]}"
unset EXPECT
if "$LIVE_SCRIPTS/run-canvas.sh"; then
  text="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next((n.get("text","") for n in d["nodes"] if n["id"]==sys.argv[2]), ""))' "$LIVE_VAULT/$CANVAS" "$out_node")"
  printf 'SMOKE OK (%s). output node text:\n%s\n' "$CANVAS" "$text"
  echo "instance pid=$(live_pid) port=$CDP_PORT"
else
  echo "SMOKE FAIL ($CANVAS)" >&2; exit 1
fi
