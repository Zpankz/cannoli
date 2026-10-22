import { describe, expect, it } from "vitest";
import { canvasDataSchema } from "../src/persistor";
import { Run } from "../src/run";
import { compileCanvas } from "./helpers/compile";

const base = { x: 0, y: 0, width: 200, height: 100 };
const meta = { v: 1, probe: "x" };

const parseOne = (node: Record<string, unknown>) =>
  canvasDataSchema.parse({ nodes: [node], edges: [] }).nodes[0] as Record<
    string,
    unknown
  >;

describe("canvas schema passthrough", () => {
  it('text node keeps unknown field "cannoli"', () => {
    const parsed = parseOne({
      id: "a",
      type: "text",
      text: "hi",
      ...base,
      cannoli: meta,
    });
    expect(parsed.cannoli).toEqual(meta);
  });

  it("file/link/group nodes keep unknown fields", () => {
    const nodes = [
      { id: "f", type: "file", file: "a.md", ...base },
      { id: "l", type: "link", url: "https://example.com", ...base },
      { id: "g", type: "group", label: "G", ...base },
    ].map((n) => ({ ...n, cannoli: meta, extra: { keep: true } }));
    const parsed = canvasDataSchema.parse({ nodes, edges: [] })
      .nodes as Record<string, unknown>[];
    for (const p of parsed) {
      expect(p.cannoli, `node ${p.id}`).toEqual(meta);
      expect(p.extra, `node ${p.id}`).toEqual({ keep: true });
    }
  });

  it("edge keeps unknown fields", () => {
    const parsed = canvasDataSchema.parse({
      nodes: [],
      edges: [
        {
          id: "e",
          fromNode: "a",
          fromSide: "right",
          toNode: "b",
          toSide: "left",
          cannoli: meta,
          extra: 1,
        },
      ],
    }).edges[0] as Record<string, unknown>;
    expect(parsed.cannoli).toEqual(meta);
    expect(parsed.extra).toBe(1);
  });

  it("typed cannoli field keeps engine keys and unknown sub-keys", () => {
    const full = {
      v: 1,
      kind: "agent",
      specHash: "sha256:9f",
      last: {
        runId: "r_1",
        status: "complete",
        tokens: 1840,
        costUsd: 0.012,
        at: "2026-10-23T10:02:19Z",
      },
      probe: "x",
    };
    const parsed = parseOne({ id: "a", type: "text", text: "", ...base, cannoli: full });
    expect(parsed.cannoli).toEqual(full);
  });

  it("malformed cannoli metadata is dropped, not fatal", () => {
    // The field is a cache (DESIGN §3.5): a bad value must never stop a run.
    const parsed = parseOne({
      id: "a",
      type: "text",
      text: "hi",
      ...base,
      cannoli: "garbage",
    });
    expect(parsed.cannoli).toBeUndefined();
    expect(parsed.text).toBe("hi");
  });
});

describe("cannoliData reaches the factory", () => {
  it("Run receives node cannoliData after parse", () => {
    // Compile once to get real cannoliData, then tamper with the node's cached
    // copy so we can tell it apart from data regenerated from node text.
    const canvas = {
      nodes: [
        { id: "prompt", type: "text", text: "Say hi", color: "6", ...base },
        { id: "call", type: "text", text: "", ...base },
        { id: "output", type: "text", text: "", color: "6", ...base },
      ],
      edges: [
        { id: "e1", fromNode: "prompt", fromSide: "right", toNode: "call", toSide: "left" },
        { id: "e2", fromNode: "call", fromSide: "right", toNode: "output", toSide: "left" },
      ],
    };
    const compiled = compileCanvas(canvas);
    const withData = structuredClone(canvas) as {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    for (const n of withData.nodes) {
      const data = structuredClone(compiled.nodes.find((c) => c.id === n.id)!.cannoliData!);
      if (n.id === "prompt") data.text = "RESUMED FROM CANNOLIDATA";
      n.cannoliData = data;
    }
    for (const e of withData.edges) {
      e.cannoliData = structuredClone(compiled.edges.find((c) => c.id === e.id)!.cannoliData!);
    }

    const run = new Run({ cannoli: withData, isMock: true, resume: true });
    const prompt = run.canvasData?.nodes.find((n) => n.id === "prompt");
    expect(prompt?.cannoliData.text).toBe("RESUMED FROM CANNOLIDATA");
  });
});
