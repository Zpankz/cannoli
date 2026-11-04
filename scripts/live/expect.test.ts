// bun test scripts/live   (or: pnpm test:live-unit)
import { describe, expect, it } from "bun:test";
import {
  evaluate,
  nodeStatus,
  normalizeExpectations,
  resolveNode,
  runOutcome,
} from "./expect";

const fixture = async (name: string) =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();

describe("expect.ts", () => {
  it("expectation passes/fails on fixture JSON", async () => {
    const hello = await fixture("hello-after.json");
    const broken = await fixture("error-after.json");
    const notices = [
      "Started cannoli: 1. Hello world",
      "Cannoli complete: 1. Hello world\nAI Requests: 1",
    ];

    const ok = evaluate(
      {
        run: "complete",
        nodes: [
          {
            node: "bc1a550bbb4aac7b",
            textMatches: "\\S",
            color: "6",
            status: "ok",
          },
          { node: "Hello world!", textMatches: "^Hello world!$", color: null },
          { node: "Cannoli", status: "ok" },
        ],
        notices: ["^Cannoli complete: 1\\. Hello world"],
        edgeCount: 1,
        nodeCount: 3,
      },
      { canvas: hello, notices },
    );
    expect(ok.results.filter((r) => !r.pass)).toEqual([]);
    expect(ok.pass).toBe(true);

    // Each kind of check can fail, and a failure names what it looked at.
    const bad = evaluate(
      {
        run: "complete",
        nodes: [
          { node: "output", textMatches: "\\S" },
          { node: "call", status: "ok" },
          { node: "output", color: null },
          { node: "missing-node", textMatches: "x" },
        ],
        notices: ["^Cannoli complete"],
        edgeCount: 2,
      },
      {
        canvas: broken,
        notices: ["Cannoli smoke failed with the error:\n\nboom"],
      },
    );
    expect(bad.pass).toBe(false);
    const failed = bad.results.filter((r) => !r.pass).map((r) => r.check);
    expect(failed).toEqual([
      "run complete",
      "node output textMatches /\\S/",
      "node call status ok",
      "node output color null",
      "node missing-node",
      "notice /^Cannoli complete/",
      "edgeCount 2",
    ]);
    expect(
      bad.results.find((r) => r.check === "node call status ok")?.detail,
    ).toContain("error");
    expect(
      bad.results.find((r) => r.check === "run complete")?.detail,
    ).toContain("error");
  });

  it("derives node status from attached error/warning nodes and call-node colours", async () => {
    const broken = await fixture("error-after.json");
    expect(nodeStatus(broken, "call")).toBe("error");
    expect(nodeStatus(broken, "output")).toBe("ok");
    // Call nodes turn yellow ("3") while executing and green ("4") when complete.
    const hello = await fixture("hello-after.json");
    const recolour = (c: string) => ({
      ...hello,
      nodes: hello.nodes.map((n: { id: string }) =>
        n.id === "dc3f9351f787531e" ? { ...n, color: c } : n,
      ),
    });
    expect(nodeStatus(recolour("4"), "dc3f9351f787531e")).toBe("complete");
    expect(nodeStatus(recolour("3"), "dc3f9351f787531e")).toBe("executing");
    expect(nodeStatus(hello, "dc3f9351f787531e")).toBe("ok");
    // A colour the node already had before the run is not a status.
    expect(nodeStatus(recolour("4"), "dc3f9351f787531e", recolour("4"))).toBe(
      "ok",
    );
    // "ok" means no error/warning, so a complete node passes it; "complete" is stricter.
    const done = recolour("4");
    expect(
      evaluate(
        {
          nodes: [
            { node: "Hello world!", status: "ok" },
            { node: "Hello world!", status: "complete" },
          ],
        },
        { canvas: done, notices: [] },
      ).pass,
    ).toBe(true);
    expect(
      evaluate(
        { nodes: [{ node: "Hello world!", status: "complete" }] },
        { canvas: hello, notices: [] },
      ).pass,
    ).toBe(false);
  });

  it("resolves nodes by id, group label, or first text line, and rejects ambiguity", async () => {
    const hello = await fixture("hello-after.json");
    expect(resolveNode(hello, "dc3f9351f787531e")).toEqual({
      id: "dc3f9351f787531e",
    });
    expect(resolveNode(hello, "Cannoli")).toEqual({ id: "161279baf7763214" });
    expect(resolveNode(hello, "Hello world!")).toEqual({
      id: "dc3f9351f787531e",
    });
    // A name present only in the pre-run canvas still resolves (output nodes start empty).
    const before = {
      ...hello,
      nodes: hello.nodes.map((n: { id: string }) =>
        n.id === "bc1a550bbb4aac7b" ? { ...n, text: "OUT" } : n,
      ),
    };
    expect(resolveNode(hello, "OUT", before)).toEqual({
      id: "bc1a550bbb4aac7b",
    });
    // ...and if the run removed that node, the check fails instead of throwing.
    const removed = {
      ...hello,
      nodes: hello.nodes.filter(
        (n: { id: string }) => n.id !== "bc1a550bbb4aac7b",
      ),
    };
    const gone = evaluate(
      { nodes: [{ node: "OUT", textMatches: "x" }] },
      { canvas: removed, before, notices: [] },
    );
    expect(gone.pass).toBe(false);
    expect(gone.results[0].detail).toContain("gone after the run");
    const dup = {
      nodes: [
        { id: "a", type: "text", text: "x" },
        { id: "b", type: "text", text: "x" },
      ],
      edges: [],
    };
    expect(resolveNode(dup, "x")).toEqual({
      error: 'ambiguous: 2 nodes match "x" (a, b)',
    });
  });

  it("accepts a bare node array and /re/flags patterns", () => {
    const exp = normalizeExpectations([{ node: "n", textMatches: "/hello/i" }]);
    expect(exp.nodes).toHaveLength(1);
    const canvas = {
      nodes: [{ id: "n", type: "text", text: "HELLO" }],
      edges: [],
    };
    expect(evaluate(exp, { canvas, notices: [] }).pass).toBe(true);
    expect(() =>
      normalizeExpectations({ nodes: [{ textMatches: "x" }] }),
    ).toThrow(/node/);
  });

  it("accepts the P0.2 meta-preserve shape: canvas, description, edit and fields", () => {
    // Verbatim shape the parallel P0.2 phase adds as scripts/live/expect/meta-preserve.json.
    const raw = {
      canvas: "Smoke/meta.canvas",
      description:
        "Obsidian Canvas preserves unknown cannoli fields when a user edits",
      edit: {
        node: "probe",
        moveBy: { x: 120, y: 80 },
        setText: "meta probe (edited)",
      },
      nodes: [
        {
          node: "probe",
          textMatches: "^meta probe \\(edited\\)$",
          fields: { "cannoli.v": 1, "cannoli.probe": "x" },
        },
      ],
    };
    const exp = normalizeExpectations(raw);
    expect(exp.canvas).toBe("Smoke/meta.canvas");
    expect(exp.description).toContain("preserves unknown");
    expect(exp.edit).toEqual({
      node: "probe",
      moveBy: { x: 120, y: 80 },
      setText: "meta probe (edited)",
    });

    const after = {
      nodes: [
        {
          id: "probe",
          type: "text",
          text: "meta probe (edited)",
          x: 120,
          y: 80,
          cannoli: { v: 1, probe: "x" },
        },
      ],
      edges: [],
    };
    expect(
      evaluate(exp, {
        canvas: after,
        notices: [],
        canvasPath: "Smoke/meta.canvas",
      }).pass,
    ).toBe(true);

    // A dropped or changed field fails, naming the dot-path and both values.
    const dropped = {
      nodes: [
        {
          id: "probe",
          type: "text",
          text: "meta probe (edited)",
          cannoli: { v: 1 },
        },
      ],
      edges: [],
    };
    const bad = evaluate(exp, {
      canvas: dropped,
      notices: [],
      canvasPath: "Smoke/meta.canvas",
    });
    expect(bad.pass).toBe(false);
    const fieldFail = bad.results.find(
      (r) => r.check === "node probe field cannoli.probe",
    );
    expect(fieldFail?.pass).toBe(false);
    expect(fieldFail?.detail).toContain('"x"');

    // A canvas mismatch fails rather than silently checking the wrong file.
    expect(
      evaluate(exp, {
        canvas: after,
        notices: [],
        canvasPath: "Smoke/other.canvas",
      }).pass,
    ).toBe(false);
    // Malformed edit / fields are rejected, never silently ignored.
    expect(() =>
      normalizeExpectations({ edit: { moveBy: { x: 1, y: 2 } }, nodes: [] }),
    ).toThrow(/edit\.node/);
    expect(() =>
      normalizeExpectations({ nodes: [{ node: "n", fields: "cannoli.v" }] }),
    ).toThrow(/fields/);
  });

  it("reads the run outcome from the final notice", () => {
    expect(runOutcome(["Started cannoli: x", "Cannoli complete: x"])).toBe(
      "complete",
    );
    expect(runOutcome(["Cannoli x failed with the error:\n\nboom"])).toBe(
      "error",
    );
    expect(runOutcome(["Cannoli stopped: x"])).toBe("stopped");
    expect(runOutcome(["Cannoli x was cancelled."])).toBe("cancelled");
    expect(runOutcome(["Cannoli run canceled."])).toBe("cancelled");
    expect(runOutcome(["Started cannoli: x"])).toBeUndefined();
  });
});
