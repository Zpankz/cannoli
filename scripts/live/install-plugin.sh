#!/usr/bin/env bash
# Copy the built plugin (main.js, manifest.json, styles.css at the repo root) into the test
# vault and enable it there. If the isolated instance is running, reload the plugin in place.
# Usage: install-plugin.sh   (run `pnpm build` first)
set -euo pipefail
source "$(dirname "$0")/env.sh"

[ -f "$LIVE_ROOT/main.js" ] || { echo "no main.js at repo root; run pnpm build" >&2; exit 1; }
[ -d "$LIVE_VAULT/.obsidian" ] || { echo "no vault at $LIVE_VAULT; run seed-vault.ts first" >&2; exit 1; }
dest="$LIVE_VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$dest"
for f in main.js manifest.json styles.css; do
  [ -f "$LIVE_ROOT/$f" ] && cp "$LIVE_ROOT/$f" "$dest/$f"
done

# Enable the plugin in the vault config. Restricted mode itself is a per-instance
# localStorage flag, which launch-isolated.sh clears over CDP (ENABLE=1).
python3 - "$LIVE_VAULT/.obsidian/community-plugins.json" "$PLUGIN_ID" <<'EOF'
import json, os, sys
path, pid = sys.argv[1], sys.argv[2]
ids = json.load(open(path)) if os.path.exists(path) else []
if pid not in ids: ids.append(pid)
json.dump(ids, open(path, "w"), indent=2)
EOF

echo "installed $PLUGIN_ID → $dest"
if [ -n "$(live_pid)" ]; then ENABLE=1 RELOAD=1 cdp; fi
