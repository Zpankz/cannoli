# Live harness (`scripts/live/`)

Runs Cannoli in an isolated Obsidian instance driven over the Chrome DevTools Protocol (CDP), against a throwaway vault and a local Ollama model. It never touches your main Obsidian or real vaults.

All mutable state lives in `<repo>/.scratch/live/` (git-ignored; override with `CANNOLI_LIVE_DIR`):

| Path | What |
|---|---|
| `vault/` | test vault: `Smoke/*.canvas`, `Cannoli College/**`, `.obsidian/plugins/cannoli/` |
| `obsidian-userdata/` | Obsidian `--user-data-dir` for the isolated instance |
| `shots/` | screenshots |
| `runs/` | one JSON report per `run-canvas` run |

**Always set `CDP_PORT`** to the port you own (default 9346). Ports 9333–9340 and 9342 are refused because other Obsidian instances use them. Each git worktree has its own `.scratch/live`, so parallel worktrees on different ports don't collide.

Needs: `bun`, `pnpm`, Obsidian.app, and Ollama serving the model (default `qwen3.5:4b`; set `OLLAMA_MODEL` when seeding to change it).

## Run a canvas and check the result

```sh
CDP_PORT=9349 CANVAS="Cannoli College/1. Basics/1. Hello world.canvas" \
  EXPECT=scripts/live/expect/hello-world.json bash scripts/live/run-canvas.sh
```

`run-canvas.sh` builds, seeds (which resets every seeded canvas), installs and reloads the plugin, and starts the instance if needed. It checks that Ollama serves the configured model, then hands off to `run-canvas.ts`, which:

1. waits until Obsidian's cached copy of the canvas matches the file on disk;
2. opens the canvas and runs `CMD` (default `cannoli:start`);
3. records every notice shown, then waits for the run's final notice (`Cannoli complete:` / `… failed with the error:` / `Cannoli stopped:` / `… cancelled`) and for `runningCannolis` to be empty. After `RUN_TIMEOUT` it stops the run and fails;
4. waits until the `.canvas` file stops changing (`SETTLE` ms), fits the canvas to the view and takes a screenshot;
5. evaluates the expectations against the file on disk, prints one ✓/✗ line per check, and writes `runs/<canvas>-<time>.json` (outcome, notices, results, console errors, screenshot path);
6. exits 0 on pass and 1 on fail, including harness failures once it is connected (plugin not loaded, canvas never synced, a CDP call timing out). It exits 2 on a usage error (bad env or expectations, canvas missing from the vault, no CDP) and when a setup step in `run-canvas.sh` fails. `smoke.sh` reports any non-zero exit as 1.

The instance stays running after a run. Stop it with `CDP_PORT=… bash scripts/live/launch-isolated.sh quit`.

| Env | Default | |
|---|---|---|
| `CANVAS` | (required) | vault-relative path |
| `EXPECT` / `EXPECT_JSON` | none | expectations file / inline JSON. `run` defaults to `complete`, so with none the run has to finish without an error; set `"run": "error"` to expect a failure. |
| `CMD` | `cannoli:start` | command id; the start command acts on the open canvas |
| `WAIT_FOR` | `run` | `none`: just wait `SETTLE` ms after `CMD` (for commands that are not runs) |
| `RUN_TIMEOUT` | `300` | seconds |
| `SETTLE` | `1500` | ms the canvas file must stay unchanged |
| `SHOT` | `shots/<canvas>-<time>.png` | screenshot path |
| `SKIP_BUILD`, `SKIP_SEED` | unset | skip `pnpm build` / reseeding (`run-canvas.sh` only) |

If the instance is already running and the plugin is installed, `bun scripts/live/run-canvas.ts` runs the check on its own, without building or seeding.

## Expectations (`expect.ts`)

An expectations file is a JSON object (or just the `nodes` array):

```json
{
  "canvas": "Cannoli College/1. Basics/1. Hello world.canvas",
  "description": "the hello-world run fills its output node",
  "run": "complete",
  "nodes": [
    { "node": "bc1a550bbb4aac7b", "textMatches": "\\S", "color": "6", "status": "ok" },
    { "node": "Hello world!", "status": "complete" }
  ],
  "notices": ["^Cannoli complete: 1\\. Hello world"],
  "edgeCount": 1,
  "nodeCount": 3
}
```

- **`canvas` / `description`**: optional. `canvas` is the vault path this file is meant for — `run-canvas.ts` refuses a mismatch; `description` says what the check proves and is not evaluated.
- **`edit`**: optional `{ "node": …, "moveBy": {"x":n,"y":n}, "setText": "…" }`. When present, `run-canvas.ts` applies the edit through the canvas view API (`setData`/`setText` + `requestSave`) instead of running a command, waits for the file to save, then evaluates the checks. This is how `meta-preserve.json` (P0.2) proves Obsidian keeps unknown node fields across a user edit.

- **`run`**: `complete | error | stopped | cancelled`, taken from the last Cannoli notice.
- **`node`**: a node id, a group label, or the first line of a node's text. It is looked up in the post-run canvas first, then in the pre-run canvas, so an output node that starts empty can still be found. A name that matches more than one node fails as ambiguous; use the id instead.
- **`textMatches` / `textNotMatches`**: a regex. A plain string gets the `s` flag; `"/re/flags"` sets the flags. For groups, the label is the text.
- **`color`**: a JSON Canvas colour string, or `null` for colourless.
- **`fields`**: `{ "dot.path": expected }` — the value at that dot-path in the node's JSON (e.g. `"cannoli.probe": "x"` on a node carrying `"cannoli":{"probe":"x"}`) must deep-equal the expected JSON value.
- **`status`**: read from the canvas file, which is the only run state Cannoli persists today:
  - `error` / `warning`: Cannoli attached a red `<u>Error:</u>` / `<u>Warning:</u>` node to it;
  - `complete`: a call node turned green (`"4"`);
  - `executing`: a call node is still yellow (`"3"`);
  - `ok`: no error or warning (complete and executing nodes also pass `ok`).

  A colour the node already had before the run doesn't count as a status.
- **`notices`**: each regex must match at least one notice shown during the run.
- **`edgeCount` / `nodeCount`**: exact counts in the post-run canvas. Error nodes count, too.

Unit tests: `pnpm test:live-unit` (= `bun test scripts/live`). Shared expectation files live in `scripts/live/expect/`.

## Seeded content (`seed-vault.ts`)

- `Smoke/hello.canvas`, `Smoke/variable.canvas`: minimal call/content canvases.
- `Smoke/parallel.canvas`: a parallel group of 8 calls whose replies merge into `output` (`expect/parallel.json`). With the seeded `pLimit: 2`, at most 2 of them reach the model at once; to see it, point `OLLAMA_URL` at a logging proxy.
- `Cannoli College/**`: all 36 Cannoli College canvases plus `Example notes/`, copied from `packages/cannoli-plugin/assets/Cannoli College` into the folder name the plugin itself uses, so the file nodes' embedded `Cannoli College/…` paths resolve. Every seed rewrites each file and deletes other files under `Cannoli College/`, so runs always start from pristine canvases. Notes that a canvas writes elsewhere in the vault are left alone. Set `SEED_COLLEGE=0` to skip this.
- `.obsidian/plugins/cannoli/data.json`: Ollama provider (`OLLAMA_URL`, `OLLAMA_MODEL`) and `pLimit: 2`, keeping any other existing settings.

## Other tools

- `smoke.sh`: a wrapper over `run-canvas.sh` for `Smoke/hello.canvas`. It expects the run to complete with the `output` node filled. Env: `CANVAS`, `OUTPUT_NODE`, `SMOKE_TIMEOUT`, `SKIP_BUILD`, `SHOT`.
- `launch-isolated.sh start|status|quit`: start the instance, show its status, or stop it.
- `install-plugin.sh`: copies the built `main.js`, `manifest.json` and `styles.css` into the vault and hot-reloads the plugin if the instance is running.
- `cdp-eval.ts`: evaluates JS in the page, plus one-shot env actions (`OPEN=`, `CMD=`, `SHOT=`, `CLICK=`, `KEYS=`, …). See its header.
- `cdp-steps.ts`: a JSON list of real-input steps run in one CDP session.

## Known limits

- Node status comes only from colours and error nodes. Per-node run events arrive with the run engine work (DESIGN §11).
- After a failed run, call nodes that never finished can stay yellow, so `executing` at the end of a run usually means "the run stopped before this node finished".
- Choice nodes depend on the model making a tool call with arguments. Small local models sometimes return a call without arguments, and Cannoli reports "Choice function call has no arguments".
