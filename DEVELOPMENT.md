# Setting up your environment

## Pre-requisites

- nvm
  - Manage node versions
  - <https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating>
- obsidian

  - Choose a vault you'd like to do development in
    - It is recommended to create a new vault for development, that does not already have cannoli installed
  - Install hot-reload plugin

    - <https://github.com/pjeby/hot-reload?tab=readme-ov-file#installation>

    - `cd <my_obsidian_vault>/.obsidian/plugins && git clone git@github.com:pjeby/hot-reload.git`

    - Make sure to enable it in obsidian once installed

- VSCode (optional)
  - Any VSCode (or descendant) editor will pick up common configuration from the cannoli repo
  - Code formatting settings and recommended extensions for cannoli development will appear when opening cannoli inside of one of these editors

## Building your dev environment

```bash
# navigate to your obsidian vault's plugin folder
cd <my_obsidian_vault>/.obsidian/plugins
# create a fork of this repo, then clone it
# replace the url here with your own fork's url
git clone git@github.com:DeabLabs/cannoli.git
cd cannoli
# install and use this repo's version of npm
nvm install
nvm use
# install pnpm
npm i -g pnpm
# from here on we will use pnpm exclusively
# it manages cannoli's monorepo
# lets install the dependencies next
pnpm install
# now we have all dependencies for the cannoli monorepo, and the cannoli-core and cannoli-plugin packages
# lets build the plugin so that it can be enabled in obsidian
pnpm build
# you should be able to enable and use your development version of the plugin in obsidian now!
```

## Development workflow

### Making code changes and seeing them live in obsidian

```bash
# open up a terminal inside of the cannoli monorepo root directory
# this can typically be done quickly by opening the repo in your editor and then opening a terminal
# install up to date dependencies, in case any have changed
pnpm install
# now lets kickoff the dev script
pnpm run dev
# this builds cannoli-core, cannoli-plugin, and then emits their files in the root of the monorepo
# once the files appear/update, the hot-reload plugin will immediately refresh the cannoli plugin within obsidian
# finally, any changes that occur to any file in the repo will trigger an automatic rebuild as long as the dev command continues to run
# so you can make a change to a file, save it, and see it appear in obsidian in typically less than one second
```

### Checks

```bash
pnpm test          # unit and golden tests (vitest, via turbo)
pnpm typecheck
pnpm build         # production build; writes main.js at the repo root
pnpm check:bundle  # fails if main.js is bigger than scripts/bundle-budget.json allows
pnpm test:bundle   # tests for the bundle check itself (node --test; needs a build)
```

Known issue: obsidian 1.14.4 typings want `@codemirror/state` 6.7.6 / `@codemirror/view` 6.43.13 while the lockfile has 6.4.1 / 6.26.3 — a types-only peer mismatch, no action needed.

The bundle budget is the 2.3.3 `main.js` size. Change `maxBytes` in
`scripts/bundle-budget.json` only on purpose, and add a `measurements` entry when you do.

`packages/cannoli-core/test/browser-safe.test.ts` bundles core for the browser (Obsidian
mobile has no Node) and lists any Node built-in imports or Node-only globals (`Buffer`,
`process`, ...). Its cases are marked `it.fails` while known uses remain.

## Run events and persistence

Core exports `RunEventBus`, `RunEvent`, `BatchedPersistor`, and `PersistorEdit`.
Subscribe before starting a run; the returned function unsubscribes. Each observer
receives its own event copy, and observer failures cannot interrupt execution.

```ts
const events = new RunEventBus();
const off = events.subscribe(event => {
  if (event.t === "text-delta") console.log(event.id, event.text);
});
const [done, stop] = run({ cannoli, events, canvasPath: "Flows/example.canvas" });
await done;
off();
```

Current events are `run-start`, `node-status` (nodes, groups and edges),
`model-request`, `text-delta`, `model-finish`, `lint`, and `run-finish`.
Model events share `id` (the graph object, empty for direct calls) and `callId`.
Prompt and output text are redacted, including credentials split across stream
chunks. Model usage is summed as reported; unknown cost is `null`. Goal-agent
usage remains limited to what its existing ModelPort reports. The start event's
`canvasHash` is a stable 32-bit FNV-1a fingerprint, not an integrity guarantee.
Agent/retry/approval events, paused runs and scoped execution belong to later phases.

Run wraps supplied persistors in `BatchedPersistor`: edits coalesce per node/edge,
text updates flush every 250 ms, and status changes flush on the next tick.
Executing snapshots remain visible for at least 300 ms; only persistence waits,
so the graph continues scheduling immediately. Finish/cancel callbacks and the
`run-finish` event occur after the final flush; persistence failure reports an
error rather than successful completion. Terminal runs cancel their remaining model
calls and settle their call events before reporting final usage. Usage includes
only what providers reported before cancellation; late responses from providers
that ignore cancellation are discarded. A run's internal cancellation leaves
its parent's shared controller available. Hosts may implement optional
`applyBatch(edits)` for one atomic transaction per flush and `flush()` to await
their own write queues. Existing Persistor methods remain supported.

The Obsidian CanvasPersistor uses one `vault.process` callback per batch, merges
against the current file, and updates only runtime text, label, colour and cannoliData on existing objects.
Current geometry, routing and extension fields stay authoritative; new objects
retain their full snapshots.
No batching setting or settings migration is required. Verify with
`pnpm --filter @deablabs/cannoli-core exec vitest run test/run/batched.test.ts test/run/events.test.ts`
and `pnpm --filter cannoli-plugin exec vitest run test/canvas.test.ts`.

## Deploying a new version of cannoli-server

```bash
pnpm changeset
# select cannoli-server with spacebar and enter
# chose major, minor, or patch
# describe the changes
# when merged into main, a PR will be opened that will trigger a new release of cannoli-server when merged
```

To manually publish:

- Update the version in the package.json like so:

```json
"version": "0.0.0-alpha.3",
```

- Run the following command:

```bash
pnpm publish --no-git-checks --access=public
```
