import { describe, expect, it } from "vitest";
import {
  type CanvasFixture,
  compileCanvas,
  hydrateGraph,
  listFixtures,
} from "../helpers/compile";

const college = listFixtures("college");
const smoke = listFixtures("smoke");

type Node = Record<string, unknown> & { id: string };
type Edge = Record<string, unknown> & { id: string };

const textNode = (id: string, text: string, color?: string): Node => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ...(color ? { color } : {}),
});

const edge = (
  id: string,
  fromNode: string,
  toNode: string,
  extra: Record<string, unknown> = {},
): Edge => ({
  id,
  fromNode,
  fromSide: "right",
  toNode,
  toSide: "left",
  ...extra,
});

const nodeType = (
  compiled: ReturnType<typeof compileCanvas>,
  id: string,
): unknown => compiled.nodes.find((n) => n.id === id)?.cannoliData?.type;

describe("compiles every College canvas without throwing", () => {
  it("finds the 36 College canvases", () => {
    expect(college).toHaveLength(36);
  });

  it.each(college.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    const compiled = compileCanvas(fixture.canvas);
    expect(compiled.nodes.length).toBeGreaterThan(0);
    // The run builds a CannoliGraph straight after compiling; that must not throw either.
    expect(() => hydrateGraph(fixture.canvas)).not.toThrow();
  });
});

describe("compile snapshot stable", () => {
  const all: CanvasFixture[] = [...college, ...smoke];

  it.each(all.map((f) => [f.name, f] as const))(
    "compile snapshot stable: %s",
    async (_name, fixture) => {
      const compiled = compileCanvas(fixture.canvas);
      await expect(JSON.stringify(compiled, null, 2) + "\n").toMatchFileSnapshot(
        `./__snapshots__/compile/${fixture.slug}.json`,
      );
    },
  );

  it("compiling twice gives the same result and does not mutate the input", () => {
    for (const fixture of all) {
      const before = JSON.stringify(fixture.canvas);
      expect(compileCanvas(fixture.canvas)).toEqual(
        compileCanvas(fixture.canvas),
      );
      expect(JSON.stringify(fixture.canvas)).toBe(before);
    }
  });
});

it("red nodes and edges are ignored", () => {
  const canvas = {
    nodes: [
      textNode("in", "Say hi", "6"),
      textNode("call", ""),
      textNode("out", "", "6"),
      textNode("redNode", "ignored call", "1"),
    ],
    edges: [
      edge("e1", "in", "call"),
      edge("e2", "call", "out"),
      edge("redEdge", "in", "out", { color: "1" }),
    ],
  };

  const compiled = compileCanvas(canvas);

  expect(compiled.nodes.map((n) => n.id)).toEqual(["call", "in", "out"]);
  expect(compiled.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(nodeType(compiled, "in")).toBe("input");
  expect(nodeType(compiled, "call")).toBe("standard-call");
  expect(nodeType(compiled, "out")).toBe("output");
  expect(() => hydrateGraph(canvas)).not.toThrow();
});

// Known bug, pinned here so P0.4 can fix it: an uncoloured arrow out of a red
// node survives compilation with a dependency on the dropped node (and
// isReflexive: true), and CannoliGraph hydration then throws
// "Cannot read properties of undefined (reading 'addEventListener')".
// When this starts passing, change it.fails to it.
it.fails("edges from a red node are dropped with it (P0.4)", () => {
  const canvas = {
    nodes: [
      textNode("in", "Say hi", "6"),
      textNode("call", ""),
      textNode("out", "", "6"),
      textNode("redNode", "ignored call", "1"),
    ],
    edges: [
      edge("e1", "in", "call"),
      edge("e2", "call", "out"),
      edge("fromRed", "redNode", "out"),
    ],
  };

  expect(compileCanvas(canvas).edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(() => hydrateGraph(canvas)).not.toThrow();
});

it("contentIsColorless swaps call/content", () => {
  const canvas = {
    nodes: [textNode("plain", "Say hi"), textNode("purple", "", "6")],
    edges: [edge("e1", "plain", "purple")],
  };

  const normal = compileCanvas(canvas);
  expect(nodeType(normal, "plain")).toBe("standard-call");
  expect(nodeType(normal, "purple")).toBe("output");

  const swapped = compileCanvas(canvas, { contentIsColorless: true });
  expect(nodeType(swapped, "plain")).toBe("input");
  expect(nodeType(swapped, "purple")).toBe("standard-call");
});
