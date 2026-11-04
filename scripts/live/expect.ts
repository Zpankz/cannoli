// Assertion DSL for live canvas runs (used by run-canvas.ts; unit-tested by expect.test.ts).
//
// An expectations file is either a bare array of node checks or an object:
//   {
//     "canvas"?:     "Smoke/meta.canvas",  // vault path this file is meant for (checked if known)
//     "description"?: "…",                 // what the check proves; carried, not evaluated
//     "edit"?:       { "node": "<id|label|first line>", "moveBy"?: {"x":n,"y":n}, "setText"?: "…" },
//                    // applied through the canvas view API instead of a run (run-canvas.ts)
//     "run":       "complete" | "error" | "stopped" | "cancelled",   // outcome from the final notice
//     "nodes":     [{ "node": "<id | group label | first text line>",
//                     "textMatches"?: "regex" | "/regex/flags",
//                     "textNotMatches"?: "regex",
//                     "color"?: "6" | null,                         // null = colourless
//                     "fields"?: { "cannoli.probe": "x" },          // dot-path → expected JSON value
//                     "status"?: "ok" | "complete" | "executing" | "error" | "warning" }],
//     "notices":   ["regex", …],     // each must match at least one notice shown during the run
//     "edgeCount"?: n, "nodeCount"?: n
//   }
// Patterns without /…/ get the "s" flag, so "." spans newlines.
//
// Node status comes from the canvas file, the only run state Cannoli persists today:
//   error / warning  CanvasPersistor attached a red ("1") node whose text starts "<u>Error:</u>"
//                    (or "<u>Warning:</u>") to it with a red edge;
//   complete         a call node turned green ("4") (CannoliObject.setStatus);
//   executing        a call node is yellow ("3");
//   ok               none of the above. As an expectation, "ok" means "no error or warning",
//                    so complete and executing nodes pass it too.
// A colour the node already had in the pre-run canvas is not read as a status.

export type CanvasNode = {
  id: string;
  type?: string;
  text?: string;
  label?: string;
  color?: string;
  [k: string]: unknown;
};
export type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  color?: string;
  label?: string;
  [k: string]: unknown;
};
export type Canvas = { nodes: CanvasNode[]; edges: CanvasEdge[] };

export type NodeStatus = "ok" | "complete" | "executing" | "error" | "warning";
export type RunOutcome = "complete" | "error" | "stopped" | "cancelled";
export type EditStep = {
  node: string;
  moveBy?: { x: number; y: number };
  setText?: string;
};
export type NodeExpectation = {
  node: string;
  textMatches?: string;
  textNotMatches?: string;
  color?: string | null;
  fields?: Record<string, unknown>;
  status?: NodeStatus;
};
export type Expectations = {
  canvas?: string;
  description?: string;
  edit?: EditStep;
  run?: RunOutcome;
  nodes: NodeExpectation[];
  notices?: string[];
  edgeCount?: number;
  nodeCount?: number;
};
export type CheckResult = { check: string; pass: boolean; detail: string };
export type Report = { pass: boolean; results: CheckResult[] };

const NODE_KEYS = new Set([
  "node",
  "textMatches",
  "textNotMatches",
  "color",
  "fields",
  "status",
]);
const STATUSES: NodeStatus[] = [
  "ok",
  "complete",
  "executing",
  "error",
  "warning",
];
const TOP_KEYS = new Set([
  "canvas",
  "description",
  "edit",
  "run",
  "nodes",
  "notices",
  "edgeCount",
  "nodeCount",
]);
const EDIT_KEYS = new Set(["node", "moveBy", "setText"]);

/** Validate raw JSON (object or bare node array) into Expectations; throws on mistakes. */
export function normalizeExpectations(raw: unknown): Expectations {
  const obj = Array.isArray(raw) ? { nodes: raw } : raw;
  if (!obj || typeof obj !== "object")
    throw new Error(
      "expectations must be an object or an array of node checks",
    );
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!TOP_KEYS.has(k)) throw new Error(`unknown expectation key "${k}"`);
  if (
    o.run !== undefined &&
    !["complete", "error", "stopped", "cancelled"].includes(o.run as string)
  )
    throw new Error(
      `run must be complete|error|stopped|cancelled, got ${JSON.stringify(o.run)}`,
    );
  for (const k of ["canvas", "description"])
    if (o[k] !== undefined && typeof o[k] !== "string")
      throw new Error(`${k} must be a string`);
  if (o.edit !== undefined) {
    const e = o.edit as Record<string, unknown>;
    if (!e || typeof e !== "object" || Array.isArray(e))
      throw new Error("edit must be an object");
    for (const k of Object.keys(e))
      if (!EDIT_KEYS.has(k)) throw new Error(`edit: unknown key "${k}"`);
    if (typeof e.node !== "string" || !e.node)
      throw new Error(
        "edit.node needs a node (id, group label or first text line)",
      );
    if (e.moveBy !== undefined) {
      const m = e.moveBy as Record<string, unknown>;
      if (!m || typeof m.x !== "number" || typeof m.y !== "number")
        throw new Error("edit.moveBy needs numeric x and y");
    }
    if (e.setText !== undefined && typeof e.setText !== "string")
      throw new Error("edit.setText must be a string");
    if (e.moveBy === undefined && e.setText === undefined)
      throw new Error("edit needs moveBy and/or setText");
  }
  const nodes = (o.nodes ?? []) as unknown[];
  if (!Array.isArray(nodes)) throw new Error("nodes must be an array");
  nodes.forEach((n, i) => {
    if (
      !n ||
      typeof n !== "object" ||
      typeof (n as NodeExpectation).node !== "string"
    )
      throw new Error(
        `nodes[${i}] needs a "node" (id, group label or first text line)`,
      );
    for (const k of Object.keys(n))
      if (!NODE_KEYS.has(k)) throw new Error(`nodes[${i}]: unknown key "${k}"`);
    const s = (n as NodeExpectation).status;
    if (s !== undefined && !STATUSES.includes(s))
      throw new Error(`nodes[${i}]: status must be ${STATUSES.join("|")}`);
    for (const k of ["textMatches", "textNotMatches"] as const) {
      const p = (n as NodeExpectation)[k];
      if (p !== undefined) parseRegex(p); // throws on a bad pattern
    }
    const f = (n as NodeExpectation).fields;
    if (
      f !== undefined &&
      (!f ||
        typeof f !== "object" ||
        Array.isArray(f) ||
        !Object.keys(f).length)
    )
      throw new Error(
        `nodes[${i}]: fields must be a non-empty object of dot-path → expected value`,
      );
  });
  const notices = o.notices as string[] | undefined;
  if (
    notices !== undefined &&
    (!Array.isArray(notices) || notices.some((n) => typeof n !== "string"))
  )
    throw new Error("notices must be an array of regex strings");
  notices?.forEach(parseRegex);
  for (const k of ["edgeCount", "nodeCount"])
    if (o[k] !== undefined && typeof o[k] !== "number")
      throw new Error(`${k} must be a number`);
  return {
    ...(o as Omit<Expectations, "nodes">),
    nodes: nodes as NodeExpectation[],
  };
}

/** "/body/flags" → RegExp(body, flags); anything else → RegExp(s, "s"). */
export function parseRegex(s: string): RegExp {
  const m = /^\/(.*)\/([dgimsuy]*)$/s.exec(s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(s, "s");
}

const firstLine = (n: CanvasNode) =>
  (n.type === "group" ? (n.label ?? "") : (n.text ?? "")).split("\n")[0].trim();

/** Find a node by id, then by group label / first text line in the canvas, then in `before`. */
export function resolveNode(
  canvas: Canvas,
  ref: string,
  before?: Canvas,
): { id: string } | { error: string } {
  if (canvas.nodes.some((n) => n.id === ref)) return { id: ref };
  for (const c of [canvas, before]) {
    if (!c) continue;
    const hits = c.nodes.filter((n) => firstLine(n) === ref.trim());
    if (hits.length === 1) return { id: hits[0].id };
    if (hits.length > 1)
      return {
        error: `ambiguous: ${hits.length} nodes match ${JSON.stringify(ref)} (${hits.map((n) => n.id).join(", ")})`,
      };
  }
  return {
    error: `no node with id, group label or first text line ${JSON.stringify(ref)}`,
  };
}

/** Run status of a node as the canvas shows it (see the header); `before` is the pre-run canvas. */
export function nodeStatus(
  canvas: Canvas,
  id: string,
  before?: Canvas,
): NodeStatus {
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
  let warning = false;
  for (const e of canvas.edges) {
    if (e.fromNode !== id) continue;
    const t = byId.get(e.toNode);
    if (t?.color !== "1") continue;
    if (t.text?.startsWith("<u>Error:</u>")) return "error";
    if (t.text?.startsWith("<u>Warning:</u>")) warning = true;
  }
  if (warning) return "warning";
  const node = byId.get(id);
  const was = before?.nodes.find((n) => n.id === id)?.color;
  if (node?.type === "text" && node.color !== was) {
    if (node.color === "4") return "complete";
    if (node.color === "3") return "executing";
  }
  return "ok";
}

const statusSatisfies = (want: NodeStatus, got: NodeStatus) =>
  want === got ||
  (want === "ok" && (got === "complete" || got === "executing"));

/** Outcome of a run from the notices Cannoli shows (packages/cannoli-plugin/src/main.ts startCannoli). */
export function runOutcome(notices: string[]): RunOutcome | undefined {
  for (let i = notices.length - 1; i >= 0; i--) {
    const t = notices[i];
    if (/^Cannoli complete: /.test(t)) return "complete";
    if (/^Cannoli .+ failed with the error:/s.test(t)) return "error";
    if (/^Cannoli stopped: /.test(t)) return "stopped";
    if (
      /^Cannoli .+ was cancelled\./.test(t) ||
      /^Cannoli run canceled\./.test(t)
    )
      return "cancelled";
  }
  return undefined;
}

/** A pattern as written, in /…/ form, for check labels. */
const show = (p: string) => (/^\/.*\/[dgimsuy]*$/s.test(p) ? p : `/${p}/`);
const short = (s: string, n = 160) =>
  (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, "\\n");

/** Value at a dot-path ("cannoli.probe") in a node object; undefined if any step is missing. */
export function fieldAt(node: Record<string, unknown>, path: string): unknown {
  let cur: unknown = node;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const deepEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** Evaluate expectations against the post-run canvas and the notices seen during the run. */
export function evaluate(
  expectations: Expectations | unknown,
  ctx: {
    canvas: Canvas;
    notices: string[];
    before?: Canvas;
    outcome?: RunOutcome;
    canvasPath?: string;
  },
): Report {
  const exp = normalizeExpectations(expectations);
  const results: CheckResult[] = [];
  const push = (check: string, pass: boolean, detail: string) =>
    results.push({ check, pass, detail });

  if (exp.canvas && ctx.canvasPath)
    push(
      `canvas ${exp.canvas}`,
      ctx.canvasPath === exp.canvas,
      `canvas ${ctx.canvasPath}`,
    );

  if (exp.run) {
    const got = ctx.outcome ?? runOutcome(ctx.notices);
    const last = ctx.notices.filter((n) => /^Cannoli /.test(n)).at(-1);
    push(
      `run ${exp.run}`,
      got === exp.run,
      `outcome ${got ?? "unknown"}${last ? ` (${short(last)})` : ""}`,
    );
  }

  for (const n of exp.nodes) {
    const r = resolveNode(ctx.canvas, n.node, ctx.before);
    if ("error" in r) {
      push(`node ${n.node}`, false, r.error);
      continue;
    }
    // A name can resolve through the pre-run canvas to a node the run removed.
    const node = ctx.canvas.nodes.find((x) => x.id === r.id);
    if (!node) {
      push(`node ${n.node}`, false, `node ${r.id} is gone after the run`);
      continue;
    }
    const text = node.type === "group" ? (node.label ?? "") : (node.text ?? "");
    if (n.textMatches !== undefined) {
      const re = parseRegex(n.textMatches);
      push(
        `node ${n.node} textMatches ${show(n.textMatches)}`,
        re.test(text),
        `text ${JSON.stringify(short(text))}`,
      );
    }
    if (n.textNotMatches !== undefined) {
      const re = parseRegex(n.textNotMatches);
      push(
        `node ${n.node} textNotMatches ${show(n.textNotMatches)}`,
        !re.test(text),
        `text ${JSON.stringify(short(text))}`,
      );
    }
    if (n.color !== undefined) {
      const got = node.color ?? null;
      push(`node ${n.node} color ${n.color}`, got === n.color, `color ${got}`);
    }
    for (const [path, want] of Object.entries(n.fields ?? {})) {
      const got = fieldAt(node, path);
      push(
        `node ${n.node} field ${path}`,
        deepEqual(got, want),
        `${path} ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
      );
    }
    if (n.status !== undefined) {
      const got = nodeStatus(ctx.canvas, r.id, ctx.before);
      push(
        `node ${n.node} status ${n.status}`,
        statusSatisfies(n.status, got),
        `status ${got}`,
      );
    }
  }

  for (const p of exp.notices ?? []) {
    const re = parseRegex(p);
    push(
      `notice ${show(p)}`,
      ctx.notices.some((t) => re.test(t)),
      `notices ${JSON.stringify(ctx.notices.map((t) => short(t, 80)))}`,
    );
  }
  if (exp.edgeCount !== undefined)
    push(
      `edgeCount ${exp.edgeCount}`,
      ctx.canvas.edges.length === exp.edgeCount,
      `edges ${ctx.canvas.edges.length}`,
    );
  if (exp.nodeCount !== undefined)
    push(
      `nodeCount ${exp.nodeCount}`,
      ctx.canvas.nodes.length === exp.nodeCount,
      `nodes ${ctx.canvas.nodes.length}`,
    );

  return { pass: results.every((r) => r.pass), results };
}
