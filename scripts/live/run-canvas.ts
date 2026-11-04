// usage: CANVAS="College/1. Basics/1. Hello world.canvas" EXPECT=scripts/live/expect/x.json bun scripts/live/run-canvas.ts
// Runs one canvas in the already-running isolated Obsidian (see run-canvas.sh for the full
// build → seed → install → launch wrapper) and checks the result:
//   open CANVAS → run CMD → wait until the run's final notice is shown and runningCannolis is
//   empty → wait for the .canvas file to stop changing → screenshot → evaluate EXPECT (expect.ts)
//   against the file on disk and the notices seen → print a report → exit 0 (pass) / 1 (fail,
//   including harness failures once connected) / 2 (bad env or expectations, no canvas, no CDP).
// Env:
//   CANVAS        vault-relative path (required)
//   EXPECT        expectations JSON file, or EXPECT_JSON inline; "run" defaults to "complete"
//                 An expectations "edit" step (see expect.ts) is applied through the canvas
//                 view API (setData/setText + requestSave) instead of running CMD, with no run.
//   CMD           command id to run (default "<plugin id>:start", which acts on the open canvas)
//   WAIT_FOR      run (default) | none — "none" just waits SETTLE ms after CMD (non-run commands)
//   RUN_TIMEOUT   seconds before the run is stopped and the check fails (default 300)
//   SETTLE        ms the canvas file must stay unchanged before it is read (default 1500)
//   SHOT          screenshot path (default .scratch/live/shots/<canvas>-<time>.png)
//   CDP_PORT, CANNOLI_LIVE_DIR as for the other scripts/live tools.
// A JSON report (outcome, notices, results, console errors, screenshot) is written to
// .scratch/live/runs/<canvas>-<time>.json.
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  evaluate,
  normalizeExpectations,
  resolveNode,
  runOutcome,
  type Canvas,
  type Expectations,
} from "./expect";
import type { CdpParams, CdpResponse, CdpTarget } from "./cdp-types";
import { cdpPort } from "./port";

const port = cdpPort();
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const live = process.env.CANNOLI_LIVE_DIR ?? join(root, ".scratch/live");
const vault = join(live, "vault");
const pluginId: string =
  process.env.PLUGIN_ID ??
  (await Bun.file(join(root, "manifest.json")).json()).id;

const canvasPath = process.env.CANVAS;
if (!canvasPath) usage("CANVAS is required");
const cmd = process.env.CMD ?? `${pluginId}:start`;
const waitFor = process.env.WAIT_FOR ?? "run";
const timeoutMs = Number(process.env.RUN_TIMEOUT ?? 300) * 1000;
const settleMs = Number(process.env.SETTLE ?? 1500);
const d = new Date(),
  pad = (n: number) => String(n).padStart(2, "0");
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const slug = basename(canvasPath!)
  .replace(/\.canvas$/, "")
  .replace(/[^\w.-]+/g, "_");
const shot = process.env.SHOT ?? join(live, "shots", `${slug}-${stamp}.png`);
const reportPath = join(live, "runs", `${slug}-${stamp}.json`);

function usage(msg: string): never {
  console.error(
    `run-canvas: ${msg}\nusage: CANVAS=<vault path> [EXPECT=file.json | EXPECT_JSON='…'] bun scripts/live/run-canvas.ts`,
  );
  process.exit(2);
}

let expectations: Expectations;
try {
  const raw =
    process.env.EXPECT_JSON ??
    (process.env.EXPECT ? await Bun.file(process.env.EXPECT).text() : "[]");
  expectations = normalizeExpectations(JSON.parse(raw));
} catch (e) {
  usage(`bad expectations: ${(e as Error).message}`);
}
if (expectations!.canvas && expectations!.canvas !== canvasPath)
  usage(
    `expectations are for canvas ${expectations!.canvas}, but CANVAS=${canvasPath}`,
  );
// A run must end in "Cannoli complete" unless the expectations say otherwise
// (set "run": "error" to expect a failure).
if (!expectations!.edit && waitFor === "run") expectations!.run ??= "complete";

const diskFile = join(vault, canvasPath!);
if (!(await Bun.file(diskFile).exists()))
  usage(`no such canvas in the live vault: ${diskFile} (seed it first)`);
const before: Canvas = JSON.parse(await Bun.file(diskFile).text());

// ---- CDP ----
const list = await (
  await fetch(`http://127.0.0.1:${port}/json/list`).catch(() =>
    usage(`no CDP on port ${port}; run launch-isolated.sh start`),
  )
).json();
const page: CdpTarget | undefined = list.find(
  (t: CdpTarget) =>
    t.type === "page" && t.url.startsWith("app://obsidian.md/index.html"),
);
if (!page) usage(`no Obsidian page on CDP port ${port}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
// A dead socket or a hung page must fail the check, not hang the process.
const cdpTimeoutMs = 60_000;
const pending = new Map<
  number,
  { resolve: (v: CdpResponse) => void; reject: (e: Error) => void }
>();
let socketDown: Error | undefined;
const failPending = (e: Error) => {
  socketDown ??= e;
  for (const p of pending.values()) p.reject(e);
  pending.clear();
};
const consoleErrors: string[] = [];
ws.onerror = () => failPending(new Error(`CDP socket error on port ${port}`));
ws.onclose = () => failPending(new Error(`CDP socket closed on port ${port}`));
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data));
  if (d.id) {
    pending.get(d.id)?.resolve(d);
    pending.delete(d.id);
  } else if (
    d.method === "Runtime.consoleAPICalled" &&
    d.params.type === "error"
  )
    consoleErrors.push(
      d.params.args
        .map(
          (a: { value?: unknown; description?: string }) =>
            a.value ?? a.description ?? "",
        )
        .join(" ")
        .slice(0, 500),
    );
  else if (d.method === "Runtime.exceptionThrown")
    consoleErrors.push(
      String(
        d.params.exceptionDetails?.exception?.description ??
          d.params.exceptionDetails?.text,
      ).slice(0, 500),
    );
};
const socketOpen = await Promise.race([
  new Promise<boolean>((r) => ws.addEventListener("open", () => r(true))),
  new Promise<boolean>((r) => ws.addEventListener("close", () => r(false))),
  sleep(10_000).then(() => false),
]);
if (!socketOpen) usage(`could not open the CDP socket on port ${port}`);
const send = (method: string, params: CdpParams = {}) =>
  new Promise<CdpResponse>((resolve, reject) => {
    if (socketDown) return reject(socketDown);
    const i = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(i);
      reject(
        new Error(`CDP ${method} timed out after ${cdpTimeoutMs / 1000}s`),
      );
    }, cdpTimeoutMs);
    pending.set(i, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
// T is what the page-side body returns; it is not checked at runtime.
const js = async <T = unknown>(body: string): Promise<T> => {
  const r = await send("Runtime.evaluate", {
    expression: `(async()=>{${body}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.result?.exceptionDetails)
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        JSON.stringify(r.result.exceptionDetails),
    );
  return r.result?.result?.value as T;
};
const P = JSON.stringify(canvasPath),
  ID = JSON.stringify(pluginId);
const t0 = Date.now();
let failure: string | undefined;
let notices: string[] = [];

try {
  await send("Runtime.enable");
  if (!(await js(`return !!app.plugins.plugins[${ID}]`)))
    throw new Error(
      `plugin ${pluginId} is not loaded (run install-plugin.sh / launch-isolated.sh start)`,
    );

  // Obsidian notices are transient DOM nodes; record every one shown from here on. A Notice
  // renders in activeWindow, which can be a popout (Obsidian 1.14 opens Settings in one), so
  // watch that document too. nodeType, not instanceof: popout nodes come from another realm.
  await js(`
    window.__cannoliLive?.observer?.disconnect();
    const notices = [], seen = new WeakSet();
    const record = (el) => { if (seen.has(el)) return; seen.add(el); setTimeout(() => notices.push(el.textContent ?? ""), 50); };
    const observer = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes)
      if (n.nodeType === 1) (n.matches(".notice") ? [n] : [...n.querySelectorAll(".notice")]).forEach(record); });
    for (const d of new Set([document, window.activeDocument ?? document]))
      observer.observe(d.body, { childList: true, subtree: true });
    window.__cannoliLive = { notices, observer };`);

  // A freshly seeded file can reach Obsidian's vault cache a moment after it hits disk, and the
  // run reads the cache; wait until they agree.
  const diskText = await Bun.file(diskFile).text();
  const synced = await js(`
    const f = app.vault.getAbstractFileByPath(${P});
    for (let i = 0; i < 50; i++) {
      const g = app.vault.getAbstractFileByPath(${P});
      if (g && (await app.vault.cachedRead(g)) === ${JSON.stringify(diskText)}) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;`);
  if (!synced)
    throw new Error(
      `Obsidian's copy of ${canvasPath} never matched the file on disk`,
    );

  const opened = await js(`
    const f = app.vault.getAbstractFileByPath(${P});
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(f, { active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await new Promise(r => setTimeout(r, 800));
    return app.workspace.getActiveFile()?.path;`);
  if (opened !== canvasPath)
    throw new Error(`active file is ${opened}, expected ${canvasPath}`);

  const edit = expectations!.edit;
  if (edit) {
    // No run: apply the edit through the canvas view API, then evaluate the saved file.
    const r = resolveNode(before, edit.node, before);
    if ("error" in r) throw new Error(`edit: ${r.error}`);
    const applied = await js(`
      const view = app.workspace.activeLeaf?.view;
      const canvas = view?.canvas;
      if (!canvas) return "active view has no canvas";
      const node = canvas.nodes.get(${JSON.stringify(r.id)});
      if (!node) return "node ${r.id} not in the canvas view";
      const d = node.getData();
      ${edit.moveBy ? `node.setData({ ...d, x: d.x + ${edit.moveBy.x}, y: d.y + ${edit.moveBy.y} });` : ""}
      ${edit.setText !== undefined ? `if (typeof node.setText !== "function") return "node ${r.id} has no setText (not a text node)"; node.setText(${JSON.stringify(edit.setText)});` : ""}
      canvas.requestSave();
      await new Promise(res => setTimeout(res, 300));
      return true;`);
    if (applied !== true) throw new Error(`edit failed: ${applied}`);
    console.log(
      `run-canvas: ${canvasPath} ← edit node ${r.id} (port ${port}, no run)`,
    );
  } else {
    const ran = await js(
      `return app.commands.executeCommandById(${JSON.stringify(cmd)});`,
    );
    if (ran === false)
      throw new Error(
        `command ${cmd} is not available here (unknown id or its check callback refused)`,
      );
    console.log(`run-canvas: ${canvasPath} ← ${cmd} (port ${port})`);

    if (waitFor === "run") {
      const deadline = Date.now() + timeoutMs;
      let outcome;
      let running = 0;
      while (Date.now() < deadline) {
        await sleep(1000);
        const s = await js<{
          notices: string[];
          running: number;
        }>(`return { notices: [...window.__cannoliLive.notices],
        running: Object.keys(app.plugins.plugins[${ID}]?.runningCannolis ?? {}).length };`);
        notices = s.notices;
        running = s.running;
        if (notices.some((n) => / is already running$/.test(n)))
          throw new Error(`the canvas was already running: ${notices.at(-1)}`);
        outcome = runOutcome(notices);
        if (outcome && running === 0) break;
      }
      if (!outcome || running) {
        // Stop the run so the instance is usable for the next check.
        await js(
          `const p = app.plugins.plugins[${ID}]; for (const [k, stop] of Object.entries(p.runningCannolis ?? {})) { stop(); delete p.runningCannolis[k]; }`,
        );
        throw new Error(
          `run did not finish within ${timeoutMs / 1000}s (outcome ${outcome ?? "none"}, running ${running})`,
        );
      }
    }
  }

  // The persistor writes edits through a queue; wait for the file to stop changing.
  let last = "",
    stableSince = Date.now();
  for (const end = Date.now() + 30000; Date.now() < end; await sleep(250)) {
    const now = await Bun.file(diskFile).text();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= settleMs) break;
  }
  notices = await js<string[]>(`return [...window.__cannoliLive.notices]`);
} catch (e) {
  failure = (e as Error).message;
}

// Screenshot even on failure. Fit the whole canvas into view first (canvas view internals; best effort).
try {
  await js(
    `try { app.workspace.activeLeaf?.view?.canvas?.zoomToFit?.(); } catch {} await new Promise(r => setTimeout(r, 600));`,
  );
  mkdirSync(dirname(shot), { recursive: true });
  const img = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(shot, Buffer.from(img.result.data, "base64"));
} catch (e) {
  failure ??= `screenshot failed: ${(e as Error).message}`;
}

const after: Canvas = JSON.parse(await Bun.file(diskFile).text());
const report = evaluate(expectations!, {
  canvas: after,
  before,
  notices,
  canvasPath,
});
const pass = !failure && report.pass;
for (const r of report.results)
  console.log(`  ${r.pass ? "✓" : "✗"} ${r.check} — ${r.detail}`);
if (failure) console.log(`  ✗ harness — ${failure}`);
if (consoleErrors.length)
  console.log(
    `  console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 3).join(" | ").slice(0, 400)}`,
  );
mkdirSync(dirname(reportPath), { recursive: true });
await Bun.write(
  reportPath,
  JSON.stringify(
    {
      canvas: canvasPath,
      cmd,
      port,
      pass,
      failure,
      outcome: runOutcome(notices),
      durationMs: Date.now() - t0,
      notices,
      results: report.results,
      consoleErrors,
      screenshot: shot,
    },
    null,
    2,
  ),
);
console.log(`screenshot: ${shot}\nreport: ${reportPath}`);
console.log(
  `${pass ? "RUN OK" : "RUN FAIL"} (${canvasPath}, ${report.results.filter((r) => r.pass).length}/${report.results.length} checks, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
ws.close();
process.exit(pass ? 0 : 1);
