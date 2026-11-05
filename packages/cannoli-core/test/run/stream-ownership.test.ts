// Real graph propagation with deterministic held admissions; not pause acceptance.
import { expect, it } from "vitest";
import { Run } from "../../src/run";
import { ChatResponseEdge } from "../../src/graph/objects/edges/ChatResponseEdge";
import { fakeVault } from "../helpers/run";

const text = (id: string, value: string, x: number, color?: string) => ({
  id,
  type: "text",
  text: value,
  x,
  y: 0,
  width: 200,
  height: 100,
  ...(color ? { color } : {}),
});
const canvas = {
  nodes: [
    text("p", "prompt", 0, "6"),
    text("c", "", 300),
    text("o", "", 600, "6"),
  ],
  edges: [
    { id: "e1", fromNode: "p", fromSide: "right", toNode: "c", toSide: "left" },
    {
      id: "e2",
      fromNode: "c",
      fromSide: "right",
      toNode: "o",
      toSide: "left",
      color: "4",
    },
  ],
};

for (const heldObjects of [["e2"], ["o"], ["e2", "o"]]) {
  it(`preserves each streamed payload while holding ${heldObjects.join(" and ")}`, async () => {
    async function exercise(hold: boolean) {
      const run = new Run({
        cannoli: structuredClone(canvas),
        isMock: false,
        fileManager: fakeVault().fileManager,
        fetcher: async () => {
          throw new Error("network refused");
        },
      });
      const edge = run.graph.e2 as ChatResponseEdge;
      const ready: Array<() => void> = [];
      if (hold)
        for (const id of heldObjects) {
          const start = run.graph[id].startExecution.bind(run.graph[id]);
          run.graph[id].startExecution = () => {
            ready.push(start);
          };
        }
      for (const content of ["one", "two", "two", "three", "END OF STREAM"])
        edge.load({ content });
      while (ready.length) ready.shift()!();
      await Promise.resolve();
      const result = run.graph.o.text;
      run.stop();
      return result;
    }
    const normal = await exercise(false);
    expect(normal).toContain("onetwotwothree");
    expect(await exercise(true)).toBe(normal);
  });
}

it("stopping discards held stream payloads and prevents late activation", () => {
  const run = new Run({ cannoli: structuredClone(canvas), isMock: false });
  const edge = run.graph.e2 as ChatResponseEdge;
  const start = edge.startExecution.bind(edge);
  edge.startExecution = () => {};
  edge.load({ content: "held" });
  run.stop();
  const before = run.graph.o.text;
  start();
  expect(run.graph.o.text).toBe(before);
});

it("fails explicitly instead of dropping stream payloads on overflow", () => {
  const run = new Run({ cannoli: structuredClone(canvas), isMock: false });
  const edge = run.graph.e2 as ChatResponseEdge;
  edge.startExecution = () => {};
  for (let i = 0; i < 1024; i++) edge.load({ content: "x" });
  expect(run.stopTime).toBeNull();
  edge.load({ content: "overflow" });
  expect(run.stopTime).not.toBeNull();
});
