import { afterEach, describe, expect, it, vi } from "vitest";
import { CannoliObjectStatus as Status } from "../../src/graph";
import type { Persistor, PersistorEdit } from "../../src/persistor";
import type { AllVerifiedCannoliCanvasNodeData } from "../../src/graph";
import { BatchedPersistor } from "../../src/runtime/batched-persistor";
import { Run, type Stoppage } from "../../src/run";
import { fakeVault } from "../helpers/run";

const node = (text: string, status = Status.Executing) =>
  ({
    id: "n",
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    text,
    cannoliData: { status },
  }) as AllVerifiedCannoliCanvasNodeData;
function sink() {
  const writes: { at: number; edits: readonly PersistorEdit[] }[] = [];
  const target: Persistor = {
    async start() {},
    async editNode(n) {
      writes.push({ at: Date.now(), edits: [{ type: "node", node: n }] });
    },
    async editEdge() {},
    async addError() {},
    async addWarning() {},
    async editOriginalParallelGroupLabel() {},
    setConfig() {},
    async applyBatch(edits) {
      writes.push({ at: Date.now(), edits: structuredClone(edits) });
    },
  };
  return { writes, target, batch: new BatchedPersistor(target) };
}
afterEach(() => vi.useRealTimers());

describe("BatchedPersistor", () => {
  it("100 text deltas in 1s produce at most five writes and keep final text", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    for (let i = 0; i < 100; i++) {
      await batch.editNode(node(String(i)));
      await vi.advanceTimersByTimeAsync(10);
    }
    await batch.flush();
    expect(writes.length).toBeLessThanOrEqual(5);
    expect(writes.at(-1)?.edits).toMatchObject([{ node: { text: "99" } }]);
  });

  it("coalesces per-chunk execute/complete churn on chat output nodes", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    for (let i = 0; i < 100; i++) {
      await batch.editNode(node(String(i), Status.Executing));
      await batch.editNode(node(String(i), Status.Complete));
      await vi.advanceTimersByTimeAsync(10);
    }
    await batch.flush();
    expect(writes.length).toBeLessThanOrEqual(5);
    expect(writes.at(-1)?.edits).toMatchObject([
      { node: { text: "99", cannoliData: { status: "complete" } } },
    ]);
  });

  it("keeps text deadlines independent of unrelated urgent status writes", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    await batch.editNode({ ...node("0"), id: "stream" });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await batch.editNode({ ...node(String(i)), id: "stream" });
      await batch.editNode({
        ...node(String(i), i % 2 ? Status.Pending : Status.Complete),
        id: "other",
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    const stream = writes.filter((w) =>
      w.edits.some((e) => e.type === "node" && e.node.id === "stream"),
    );
    expect(stream.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < stream.length; i++)
      expect(stream[i].at - stream[i - 1].at).toBeLessThanOrEqual(250);
    await batch.flush();
  });

  it("preserves different diagnostics for the same node while coalescing duplicates", async () => {
    const { batch, writes } = sink();
    await batch.addWarning("n", "first missing note");
    await batch.addWarning("n", "second missing note");
    await batch.addWarning("n", "first missing note");
    await batch.addError("n", "first error");
    await batch.addError("n", "second error");
    await batch.flush();
    expect(writes.flatMap((w) => w.edits)).toHaveLength(4);
  });

  it("status changes coalesce and flush next tick", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    await batch.editNode(node("a"));
    await batch.editNode(node("b"));
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].edits).toMatchObject([{ node: { text: "b" } }]);
  });

  it("paints executing for 300ms even when the graph completes in one tick", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    await batch.editNode(node("running"));
    await batch.editNode(node("complete", Status.Complete));
    const finished = batch.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].edits).toMatchObject([
      { node: { cannoliData: { status: "executing" } } },
    ]);
    await vi.advanceTimersByTimeAsync(299);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await finished;
    expect(writes).toHaveLength(2);
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(300);
    expect(writes[1].edits).toMatchObject([
      { node: { text: "complete", cannoliData: { status: "complete" } } },
    ]);
  });

  it("final flush persists edits made during a slow write", async () => {
    const { writes, batch, target } = sink();
    const apply = target.applyBatch!;
    target.applyBatch = async (edits) => {
      if (!writes.length) await batch.editNode(node("newer", Status.Pending));
      await apply(edits);
    };
    await batch.editNode(node("first", Status.Pending));
    await batch.flush();
    expect(writes.at(-1)?.edits).toMatchObject([{ node: { text: "newer" } }]);
  });

  it("waits only for paints with pending edits when flushing several nodes", async () => {
    vi.useFakeTimers();
    const { batch, writes } = sink();
    await batch.editNode(node("first"));
    await vi.advanceTimersByTimeAsync(400);
    await batch.editNode({ ...node("second"), id: "other" });
    await batch.editNode({ ...node("finished", Status.Complete), id: "other" });
    const flushed = batch.flush();
    await vi.advanceTimersByTimeAsync(300);
    await flushed;
    expect(writes.at(-1)?.edits).toMatchObject([
      { node: { id: "other", text: "finished" } },
    ]);
  });

  it("reports a failed timer write through flush without unhandled rejections", async () => {
    vi.useFakeTimers();
    const { target, batch } = sink();
    target.applyBatch = async () => {
      throw new Error("disk full");
    };
    await batch.editNode(node("x"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(batch.flush()).rejects.toThrow("disk full");
  });

  it("supports legacy persistors and snapshots mutable callers", async () => {
    const { target, writes, batch } = sink();
    delete target.applyBatch;
    const n = node("saved", Status.Pending);
    await batch.editNode(n);
    n.text = "mutated";
    await batch.flush();
    expect(writes[0].edits).toMatchObject([{ node: { text: "saved" } }]);
  });
});

it("joins edits enqueued reentrantly by the target flush", async () => {
  const { batch, target, writes } = sink();
  let flushes = 0;
  target.flush = async () => {
    if (++flushes === 1)
      await batch.editNode(node("during flush", Status.Pending));
  };
  await batch.editNode(node("before", Status.Pending));
  await batch.flush();
  expect(writes.at(-1)?.edits).toMatchObject([
    { node: { text: "during flush" } },
  ]);
  expect(flushes).toBe(2);
});

it("does not acknowledge a flush while its target is still writing", async () => {
  const { batch, target } = sink();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  target.flush = () => barrier;
  let finished = false;
  const flush = batch.flush().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  release();
  await flush;
  expect(finished).toBe(true);
});

it("concurrent barriers converge and each observes durable writes", async () => {
  const { batch, writes } = sink();
  await batch.editNode(node("queued", Status.Pending));
  await Promise.all(
    [0, 1, 2].map(async () => {
      await batch.flush();
      expect(writes.at(-1)?.edits).toMatchObject([
        { node: { text: "queued" } },
      ]);
    }),
  );
});

it("joins edits admitted near the completion of another barrier", async () => {
  for (let depth = 1; depth <= 5; depth++) {
    const { batch, target, writes } = sink();
    let calls = 0;
    let resolveLater!: () => void;
    const later = new Promise<void>((resolve) => {
      resolveLater = resolve;
    });
    target.flush = async () => {
      if (++calls !== 1) return;
      const defer = (remaining: number) =>
        queueMicrotask(() => {
          if (remaining > 1) {
            defer(remaining - 1);
            return;
          }
          void batch.editNode(node("late", Status.Pending));
          void batch.flush().then(resolveLater);
        });
      defer(depth);
    };
    await batch.editNode(node("early", Status.Pending));
    await batch.flush();
    await later;
    expect(writes.at(-1)?.edits).toMatchObject([{ node: { text: "late" } }]);
  }
});

it("allows a finite target callback to await its own follow-up writes", async () => {
  const { batch, target, writes } = sink();
  let calls = 0;
  target.flush = async () => {
    if (++calls === 1) {
      await batch.editNode(node("callback", Status.Pending));
      await batch.flush();
      expect(writes.at(-1)?.edits).toMatchObject([
        { node: { text: "callback" } },
      ]);
    }
  };
  await batch.editNode(node("initial", Status.Pending));
  await batch.flush();
  expect(writes.at(-1)?.edits).toMatchObject([{ node: { text: "callback" } }]);
});

it("persists a final run diagnostic admitted while an external barrier ends", async () => {
  const { target } = sink();
  const diagnostics: string[] = [];
  target.addError = async (_id, message) => {
    diagnostics.push(message);
  };
  delete target.applyBatch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    first = resolve;
  });
  let finish!: (result: Stoppage) => void;
  const done = new Promise<Stoppage>((resolve) => {
    finish = resolve;
  });
  let atFinish: string[] = [];
  const run = new Run({
    cannoli: {
      nodes: [
        { ...node("prompt", Status.Pending), id: "c" },
        { ...node("", Status.Pending), id: "o", color: "6", x: 300 },
      ],
      edges: [
        {
          id: "e",
          fromNode: "c",
          toNode: "o",
          fromSide: "right",
          toSide: "left",
          color: "4",
        },
      ],
    },
    isMock: false,
    fileManager: fakeVault().fileManager,
    fetcher: async () => {
      throw new Error("network refused");
    },
    llmConfigs: [{ provider: "ollama", model: "fake" }],
    persistor: target,
    onFinish: (result) => {
      atFinish = [...diagnostics];
      finish(result);
    },
  });
  run.model = {
    async generate() {
      throw new Error("unexpected generate");
    },
    async *stream() {
      yield { type: "text-delta", text: "partial" };
      await gate;
    },
  };
  run.events.subscribe((event) => {
    if (
      event.t === "node-status" &&
      event.id === "o" &&
      event.status === "complete"
    )
      first();
  });
  try {
    await run.start();
    await firstChunk;
    let calls = 0;
    target.flush = async () => {
      if (++calls === 1)
        queueMicrotask(() =>
          queueMicrotask(() =>
            queueMicrotask(() =>
              run.nodeExecutionFailed(
                run.graph.c,
                new Error("final diagnostic"),
              ),
            ),
          ),
        );
    };
    await run.persistor!.flush!();
    expect((await done).reason).toBe("error");
    expect(atFinish).toEqual(["final diagnostic"]);
  } finally {
    release();
    run.stop();
    await run.persistor!.flush!();
  }
});
