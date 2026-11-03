// usage: bun scripts/live/cdp-steps.ts steps.json   (or -e '<json>')
// Runs a sequence of real-input steps in one CDP session, resolving each target's position
// right before the input (pages that scroll between separate cdp-eval calls leave stale
// coordinates). Steps:
//   {"eval": "js"}                    evaluate (async body; `return` a value to print it)
//   {"hover": "js → Element"}         scroll into view if needed, real mouse move to its centre ("at": [fx, fy] picks another point)
//   {"click": "js → Element"}         real click at its centre ("mods": CDP bitmask 1 Alt, 2 Ctrl, 4 Meta, 8 Shift;
//                                     {"dblclick": …} for a double-click)
//   {"tap": "js → Element"}           real touch tap (touchStart/touchEnd)
//   {"drag": "js → Element", "by": [dx, dy]}   real left-button drag from its centre
//   {"type": "text"} {"keys": "Enter,Mod+Enter"} {"wait": ms} {"shot": "path.png"}
//   {"cdp": "Domain.method", "params": {…}}   raw CDP call (e.g. Emulation.setEmulatedMedia)
//   {"keydown": "Meta|Control|Alt|Shift|Mod"} / {"keyup": …}   hold / release a modifier across steps
//                                     (page-level KeyboardEvent; combine with "mods" on clicks)
// Env: CDP_PORT (default 9346, the isolated Cannoli instance), PRE_JS (prepended to every eval/selector, e.g. helpers).
import { keyCodes } from "./keys";
import type { CdpParams, CdpResponse, CdpTarget } from "./cdp-types";
import { cdpPort } from "./port";
const port = cdpPort();
setTimeout(
  () => {
    console.log("TIMEOUT");
    process.exit(3);
  },
  Number(process.env.T ?? 180000),
);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(
  (t: CdpTarget) =>
    t.type === "page" && t.url.startsWith("app://obsidian.md/index.html"),
);
const raw =
  process.argv[2] === "-e"
    ? process.argv[3]!
    : await Bun.file(process.argv[2]!).text();
/** One step of the steps file (see the usage comment above). */
interface Step {
  eval?: string;
  hover?: string;
  click?: string;
  dblclick?: string;
  tap?: string;
  drag?: string;
  at?: [number, number];
  by?: [number, number];
  mods?: number;
  wait?: number;
  type?: string;
  keys?: string;
  keydown?: string;
  keyup?: string;
  cdp?: string;
  params?: CdpParams;
  shot?: string;
}
const steps: Step[] = JSON.parse(raw);
const pre = process.env.PRE_JS ?? "";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (body: string) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async()=>{${pre}\n${body}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.result?.exceptionDetails)
    throw new Error(
      JSON.stringify(
        r.result.exceptionDetails.exception?.description ??
          r.result.exceptionDetails,
      ),
    );
  return r.result?.result?.value;
};
const centre = async (
  expr: string,
  at: [number, number] = [0.5, 0.5],
): Promise<[number, number]> => {
  const v = await evaluate(`const el = (${expr}); if (!el) return null;
    const vh = innerHeight, b0 = el.getBoundingClientRect();
    if (b0.top < 60 || b0.bottom > vh - 40) { el.scrollIntoView({ block: "center" }); await new Promise(r => setTimeout(r, 400)); }
    const b = el.getBoundingClientRect(); return [Math.round(b.x + b.width * ${at[0]}), Math.round(b.y + b.height * ${at[1]})];`);
  if (!v) throw new Error(`no element for ${expr}`);
  return v as [number, number];
};
const KEYS: Record<string, [string, number]> = {
  Enter: ["Enter", 13],
  Escape: ["Escape", 27],
  Tab: ["Tab", 9],
  Backspace: ["Backspace", 8],
  ArrowDown: ["ArrowDown", 40],
  ArrowUp: ["ArrowUp", 38],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  End: ["End", 35],
  Home: ["Home", 36],
};
const press = async (spec: string) => {
  const parts = spec.split("+");
  const name = parts.pop()!;
  let modifiers = 0;
  for (const m of parts)
    modifiers |=
      (
        { Alt: 1, Ctrl: 2, Meta: 4, Mod: 4, Shift: 8 } as Record<string, number>
      )[m] ?? 0;
  const k = KEYS[name];
  const key = k ? k[0] : name;
  const code = k ? k[1] : name.toUpperCase().charCodeAt(0);
  const text =
    name === "Enter" && !(modifiers & 6)
      ? "\r"
      : !k && name.length === 1 && !(modifiers & 6)
        ? name
        : undefined;
  await send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key,
    code: k ? key : `Key${name.toUpperCase()}`,
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
  await sleep(80);
};
const MOD_KEYS: Record<string, { key: string; code: string; bit: number }> = {
  Meta: { key: "Meta", code: "MetaLeft", bit: 4 },
  Control: { key: "Control", code: "ControlLeft", bit: 2 },
  Alt: { key: "Alt", code: "AltLeft", bit: 1 },
  Shift: { key: "Shift", code: "ShiftLeft", bit: 8 },
};
let heldMods = 0;
/**
 * Press (down) or release (up) a modifier key and keep it held between steps.
 * Dispatched in the page: a CDP key event for a modifier key reaches macOS as a
 * keyDown with no characters, which with Cmd held runs the first app-menu item
 * without a shortcut (Obsidian's modal About box, which blocks the app).
 */
const holdKey = async (name: string, down: boolean) => {
  const k =
    MOD_KEYS[
      name === "Mod"
        ? process.platform === "darwin"
          ? "Meta"
          : "Control"
        : name
    ];
  if (!k) throw new Error(`unknown modifier ${name}`);
  heldMods = down ? heldMods | k.bit : heldMods & ~k.bit;
  const init = {
    key: k.key,
    code: k.code,
    altKey: !!(heldMods & 1),
    ctrlKey: !!(heldMods & 2),
    metaKey: !!(heldMods & 4),
    shiftKey: !!(heldMods & 8),
    bubbles: true,
    cancelable: true,
  };
  await evaluate(
    `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent(${JSON.stringify(down ? "keydown" : "keyup")}, ${JSON.stringify(init)}))`,
  );
  await sleep(120);
};
const out: unknown[] = [];
try {
  for (const s of steps) {
    if (s.eval !== undefined) {
      const v = await evaluate(s.eval);
      if (v !== undefined) out.push(v);
    } else if (s.hover) {
      const [x, y] = await centre(s.hover, s.at);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(s.wait ?? 450);
    } else if (s.click) {
      const [x, y] = await centre(s.click, s.at);
      const modifiers = Number(s.mods ?? 0);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          modifiers,
          button: type === "mouseMoved" ? "none" : "left",
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
      await sleep(s.wait ?? 500);
    } else if (s.dblclick) {
      const [x, y] = await centre(s.dblclick, s.at);
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
      await sleep(s.wait ?? 700);
    } else if (s.drag) {
      const [x, y] = await centre(s.drag, s.at);
      const [dx, dy] = s.by ?? [40, 0];
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(200);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      for (let i = 1; i <= 10; i++) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: x + (dx * i) / 10,
          y: y + (dy * i) / 10,
          button: "left",
          buttons: 1,
        });
        await sleep(40);
      }
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x + dx,
        y: y + dy,
        button: "left",
        clickCount: 1,
      });
      await sleep(s.wait ?? 900);
    } else if (s.tap) {
      const [x, y] = await centre(s.tap, s.at);
      await send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await sleep(s.wait ?? 600);
    } else if (s.type !== undefined) {
      for (const ch of s.type as string) {
        if (ch === "\n") {
          await press("Enter");
          continue;
        }
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: ch,
          text: ch,
          unmodifiedText: ch,
        });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        await sleep(45);
      }
      await sleep(s.wait ?? 400);
    } else if (s.keys) {
      for (const k of String(s.keys).split(",")) await press(k);
      await sleep(s.wait ?? 400);
    } else if (s.keydown) await holdKey(s.keydown, true);
    else if (s.keyup) await holdKey(s.keyup, false);
    else if (s.cdp)
      out.push((await send(s.cdp, s.params ?? {})).result ?? null);
    else if (s.wait) await sleep(s.wait);
    else if (s.shot) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      await Bun.write(s.shot, Buffer.from(r.result!.data!, "base64"));
    }
  }
} catch (e) {
  out.push(`ERROR: ${(e as Error).message}`);
}
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
