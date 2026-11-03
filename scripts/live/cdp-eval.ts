// usage: bun scripts/live/cdp-eval.ts [file.js | -e code]
// Evaluates (async) JS in the isolated Obsidian test instance (see launch-isolated.sh) and
// prints the JSON result. Env (applied in this order, all optional):
//   CDP_PORT (default 9346), T (timeout ms), PRE=js (runs first),
//   ENABLE=1  leave restricted mode, accept the vault-trust prompt, enable the plugin (persisted)
//   RELOAD=1  re-read manifests and disable+enable the plugin (picks up a new main.js)
//   OPEN=path open a vault file in the active leaf (e.g. "Smoke/hello.canvas")
//   MOUSE=x,y (hover, MODS=bitmask), CLICK=x,y (MODS, BUTTON=middle|right), DBLCLICK=x,y,
//   DRAG=x1,y1,x2,y2, WHEEL=x,y,dx,dy[,n], TYPE=text, INSERT=text, KEYS=Enter,Mod+Enter,…,
//   KEYDOWN=Meta / KEYUP=Meta (page events),
//   CMD=id    run a command by id (e.g. "cannoli:start"), WAIT=ms sleep after it,
//   SHOT=<png path> screenshot, then the eval itself.
// PLUGIN_ID defaults to the id in the repo's manifest.json.
import { keyCodes } from "./keys";
import type { CdpParams, CdpResponse, CdpTarget } from "./cdp-types";
import { cdpPort } from "./port";
const port = cdpPort();
const pluginId =
  process.env.PLUGIN_ID ??
  (await Bun.file(new URL("../../manifest.json", import.meta.url)).json()).id;
setTimeout(
  () => {
    console.log("TIMEOUT");
    process.exit(3);
  },
  Number(process.env.T ?? 100000),
);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(
  (t: CdpTarget) =>
    t.type === "page" && t.url.startsWith("app://obsidian.md/index.html"),
);
const code =
  process.argv[2] === "-e"
    ? process.argv[3]
    : process.argv[2]
      ? await Bun.file(process.argv[2]).text()
      : "";
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, (v: CdpResponse) => void>();
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data));
  pending.get(d.id)?.(d);
};
await new Promise((r) => (ws.onopen = r));
const send = (method: string, params: CdpParams = {}) =>
  new Promise<CdpResponse>((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
// PRE=js — evaluated before any input (e.g. open an editor, then TYPE into it).
if (process.env.PRE) {
  const r = await send("Runtime.evaluate", {
    expression: `(async()=>{${process.env.PRE}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.result?.exceptionDetails)
    console.log("PRE error", JSON.stringify(r.result.exceptionDetails));
}
const run = async (label: string, body: string) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async()=>{${body}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.result?.exceptionDetails)
    console.log(
      `${label} error`,
      JSON.stringify(
        r.result.exceptionDetails.exception?.description ??
          r.result.exceptionDetails,
      ),
    );
  return r.result?.result?.value;
};
const ID = JSON.stringify(pluginId);
if (process.env.ENABLE) {
  const v = await run(
    "ENABLE",
    `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // First open of a vault listing community plugins asks whether to trust its author.
    for (let i = 0; i < 10; i++) {
      const b = [...document.querySelectorAll(".modal-container button")].find(b => /trust/i.test(b.textContent));
      if (b) { b.click(); await sleep(800); break; }
      await sleep(200);
    }
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    await app.plugins.loadManifests();
    if (!app.plugins.enabledPlugins.has(${ID}) || !app.plugins.plugins[${ID}]) await app.plugins.enablePluginAndSave(${ID});
    document.querySelectorAll(".modal-container .modal-close-button").forEach(b => b.click());
    return { restrictedOff: app.plugins.isEnabled(), loaded: !!app.plugins.plugins[${ID}] };`,
  );
  console.log("ENABLE", JSON.stringify(v));
}
if (process.env.RELOAD) {
  const v = await run(
    "RELOAD",
    `
    await app.plugins.disablePlugin(${ID});
    await app.plugins.loadManifests();
    await app.plugins.enablePlugin(${ID});
    return { loaded: !!app.plugins.plugins[${ID}], version: app.plugins.manifests[${ID}]?.version };`,
  );
  console.log("RELOAD", JSON.stringify(v));
}
if (process.env.OPEN) {
  const v = await run(
    "OPEN",
    `
    const f = app.vault.getAbstractFileByPath(${JSON.stringify(process.env.OPEN)});
    if (!f) throw new Error("no such file: " + ${JSON.stringify(process.env.OPEN)});
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(f, { active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await new Promise(r => setTimeout(r, 800));
    return app.workspace.getActiveFile()?.path;`,
  );
  console.log("OPEN", JSON.stringify(v));
}
if (process.env.MOUSE) {
  const [x, y] = process.env.MOUSE.split(",").map(Number);
  // MODS = CDP modifier bitmask for the hover (1 Alt, 2 Ctrl, 4 Meta, 8 Shift), e.g. Cmd-hover page previews.
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    modifiers: Number(process.env.MODS ?? 0),
  });
  await new Promise((r) => setTimeout(r, 400));
}
// CLICK=x,y — real click; MODS=bitmask (as for MOUSE) holds modifiers, BUTTON=middle|right picks the button.
if (process.env.CLICK) {
  const [x, y] = process.env.CLICK.split(",").map(Number);
  const modifiers = Number(process.env.MODS ?? 0);
  const button = process.env.BUTTON ?? "left";
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : button,
      clickCount: type === "mouseMoved" ? 0 : 1,
      modifiers,
    });
  await new Promise((r) => setTimeout(r, 600));
}
// DBLCLICK=x,y — a real double-click (second press carries clickCount 2, so `dblclick` fires).
if (process.env.DBLCLICK) {
  const [x, y] = process.env.DBLCLICK.split(",").map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const clickCount of [1, 2])
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount,
      });
  await new Promise((r) => setTimeout(r, 600));
}
// DRAG=x1,y1,x2,y2 — real left-button drag (MODS held throughout).
if (process.env.DRAG) {
  const [x1, y1, x2, y2] = process.env.DRAG.split(",").map(Number);
  const modifiers = Number(process.env.MODS ?? 0);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: x1,
    y: y1,
    modifiers,
  });
  await new Promise((r) => setTimeout(r, 200));
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: x1,
    y: y1,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  for (let i = 1; i <= 10; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x1 + ((x2 - x1) * i) / 10,
      y: y1 + ((y2 - y1) * i) / 10,
      button: "left",
      buttons: 1,
      modifiers,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x2,
    y: y2,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  await new Promise((r) => setTimeout(r, 800));
}
// WHEEL=x,y,dx,dy[,steps] — real mouse-wheel input (steps events of dx/dy px each, default 1).
if (process.env.WHEEL) {
  const [x, y, dx, dy, steps = 1] = process.env.WHEEL.split(",").map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < steps; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: dx,
      deltaY: dy,
    });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 500));
}
// TYPE=text — real typing: one keyDown (with text) + keyUp per character, so editors see
// key events and input like a person typing ("\n" is Enter). INSERT=text — one
// Input.insertText (IME-style commit, no key events).
// KEYS=Enter,Escape,ArrowDown,Mod+Enter,… — real key presses (Mod = Meta on macOS; MODS also applies).
const KEY_CODES: Record<string, [string, number]> = {
  Enter: ["Enter", 13],
  Escape: ["Escape", 27],
  Tab: ["Tab", 9],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowDown: ["ArrowDown", 40],
  ArrowUp: ["ArrowUp", 38],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36],
  End: ["End", 35],
  Space: [" ", 32],
};
const pressKey = async (spec: string) => {
  const parts = spec.split("+");
  const name = parts.pop()!;
  let modifiers = Number(process.env.MODS ?? 0);
  for (const m of parts)
    modifiers |=
      (
        { Alt: 1, Ctrl: 2, Meta: 4, Mod: 4, Shift: 8 } as Record<string, number>
      )[m] ?? 0;
  const known = KEY_CODES[name];
  const key = known ? known[0] : name;
  const code = known ? known[1] : name.toUpperCase().charCodeAt(0);
  const text =
    name === "Enter" && !(modifiers & 6)
      ? "\r"
      : !known && name.length === 1 && !(modifiers & 6)
        ? name
        : undefined;
  await send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key,
    code: known ? key : `Key${name.toUpperCase()}`,
    ...keyCodes(key, code),
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    ...keyCodes(key, code),
    modifiers,
  });
  await new Promise((r) => setTimeout(r, 60));
};
if (process.env.TYPE) {
  for (const ch of process.env.TYPE) {
    if (ch === "\n") {
      await pressKey("Enter");
      continue;
    }
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: ch,
      text: ch,
      unmodifiedText: ch,
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 400));
}
if (process.env.INSERT) {
  await send("Input.insertText", { text: process.env.INSERT });
  await new Promise((r) => setTimeout(r, 400));
}
if (process.env.KEYS) {
  for (const k of process.env.KEYS.split(",")) await pressKey(k);
  await new Promise((r) => setTimeout(r, 400));
}
// KEYDOWN=Meta,Alt / KEYUP=Meta — modifier key events (MODS = the flags they carry), dispatched in
// the page: a CDP key event for a modifier key reaches macOS as a character-less keyDown, which
// with Cmd held runs the first app-menu item without a shortcut (Obsidian's modal About box).
const MODKEY: Record<string, [string, string]> = {
  Meta: ["Meta", "MetaLeft"],
  Control: ["Control", "ControlLeft"],
  Alt: ["Alt", "AltLeft"],
  Shift: ["Shift", "ShiftLeft"],
};
for (const [env, type] of [
  ["KEYDOWN", "keydown"],
  ["KEYUP", "keyup"],
] as const) {
  if (!process.env[env]) continue;
  const m = Number(process.env.MODS ?? 0);
  for (const name of process.env[env]!.split(",")) {
    const k =
      MODKEY[
        name === "Mod"
          ? process.platform === "darwin"
            ? "Meta"
            : "Control"
          : name
      ];
    if (!k) continue;
    const init = {
      key: k[0],
      code: k[1],
      altKey: !!(m & 1),
      ctrlKey: !!(m & 2),
      metaKey: !!(m & 4),
      shiftKey: !!(m & 8),
      bubbles: true,
      cancelable: true,
    };
    await send("Runtime.evaluate", {
      expression: `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("${type}", ${JSON.stringify(init)}))`,
    });
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (process.env.CMD) {
  const v = await run(
    "CMD",
    `return app.commands.executeCommandById(${JSON.stringify(process.env.CMD)});`,
  );
  console.log("CMD", process.env.CMD, JSON.stringify(v));
}
if (process.env.WAIT)
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT)));
if (process.env.SHOT) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(process.env.SHOT, Buffer.from(r.result!.data!, "base64"));
}
if (code) {
  const r = await send("Runtime.evaluate", {
    expression: `(async()=>{${code}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  console.log(
    JSON.stringify(
      r.result?.result?.value ?? r.result?.exceptionDetails ?? r,
      null,
      1,
    ),
  );
}
ws.close();
process.exit(0);
