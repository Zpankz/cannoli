import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { PersistorEdit } from "@deablabs/cannoli-core";
import { CanvasPersistor } from "../src/canvas";

const initial = {
  nodes: [
    {
      id: "n",
      type: "text" as const,
      text: "old",
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      foreign: { keep: true },
    },
  ],
  edges: [
    {
      id: "e",
      fromNode: "n",
      toNode: "n",
      fromSide: "right" as const,
      toSide: "left" as const,
      foreign: 42,
    },
  ],
  custom: "preserve",
};
function host() {
  let content = JSON.stringify(initial);
  let processes = 0;
  let reads = 0;
  const file = {
    vault: {
      async read() {
        reads++;
        return content;
      },
      async process(_file: unknown, fn: (s: string) => string) {
        processes++;
        content = fn(content);
        return content;
      },
    },
  } as unknown as TFile;
  return {
    persistor: new CanvasPersistor(initial, file),
    data: () => JSON.parse(content),
    edit: (s: string) => {
      content = s;
    },
    counts: () => ({ processes, reads }),
  };
}
const edits = [
  {
    type: "node",
    node: {
      ...initial.nodes[0],
      text: "new",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      cannoliData: { status: "executing" },
    },
  },
  {
    type: "edge",
    edge: { ...initial.edges[0], label: "updated", cannoliData: {} },
  },
] as unknown as PersistorEdit[];

describe("CanvasPersistor", () => {
  it("applyBatch does one atomic read-modify-write and retains live geometry/unknown fields", async () => {
    const h = host();
    const changed = structuredClone(initial);
    changed.nodes[0].x = 999;
    h.edit(JSON.stringify(changed));
    await h.persistor.applyBatch(edits);
    expect(h.counts()).toEqual({ processes: 1, reads: 0 });
    expect(h.data()).toMatchObject({
      custom: "preserve",
      nodes: [
        {
          x: 999,
          y: 20,
          width: 300,
          height: 200,
          text: "new",
          foreign: { keep: true },
        },
      ],
      edges: [{ label: "updated", foreign: 42 }],
    });
    expect(h.data().nodes[0]).not.toHaveProperty("cannoliData");
    expect(edits[0]).toMatchObject({
      node: { x: 0, cannoliData: { status: "executing" } },
    });
  });

  it("start removes old diagnostics and merges in one transaction", async () => {
    const h = host();
    const data = structuredClone(initial);
    data.nodes.push({
      ...data.nodes[0],
      id: "error",
      color: "1",
      text: "<u>Error:</u>\nold",
    } as (typeof data.nodes)[0]);
    h.edit(JSON.stringify(data));
    await h.persistor.start({ nodes: [], edges: [] });
    expect(h.counts()).toEqual({ processes: 1, reads: 0 });
    expect(h.data().nodes.map((n: { id: string }) => n.id)).toEqual(["n"]);
  });
});
