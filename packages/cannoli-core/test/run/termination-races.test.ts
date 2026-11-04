import { describe, expect, it } from "vitest";
import { abortableStream, RunController } from "../../src/runtime/controller";
import { Run } from "../../src/run";
import { RunEventBus, type RunEvent } from "../../src/runtime/events";
import type { GenerateResult, ModelStreamEvent } from "../../src/model/types";

const box = { type: "text", x: 0, y: 0, width: 200, height: 100 };
const canvas = {
  nodes: [
    { ...box, id: "c", text: "hi" },
    { ...box, id: "o", text: "", color: "6" },
  ],
  edges: [
    { id: "e", fromNode: "c", toNode: "o", fromSide: "right", toSide: "left" },
  ],
};
const request = {
  model: "fake",
  messages: [{ role: "user" as const, content: "hi" }],
};
const result: GenerateResult = {
  text: "ok",
  messages: [],
  usage: { inputTokens: 7, outputTokens: 4 },
  finishReason: "stop",
};
function setup() {
  const events = new RunEventBus();
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const run = new Run({
    cannoli: structuredClone(canvas),
    events,
    llmConfigs: [{ provider: "ollama", model: "fake" }],
  });
  return { run, events, seen };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function cancelAfterResolution(run: Run, stop: boolean) {
  queueMicrotask(() =>
    queueMicrotask(() => {
      if (stop) run.stop();
      else run.nodeExecutionFailed(run.graph.c, new Error("parallel failure"));
    }),
  );
}

describe("terminal races", () => {
  for (const kind of ["generate", "goal"] as const) {
    it.each([false, true])(
      `${kind} discards a fulfilled response when cancellation wins before continuation (stop=%s)`,
      async (stop) => {
        const { run, seen } = setup();
        const respond = () => {
          const p = Promise.resolve(result);
          cancelAfterResolution(run, stop);
          return p;
        };
        const model = {
          generate: respond,
          goal: respond,
          async *stream(): AsyncGenerator<ModelStreamEvent> {},
        };
        run.model = model;
        const call =
          kind === "generate"
            ? run.callLLM(request)
            : run.callGoalAgent({ request });
        await expect(call).rejects.toBeDefined();
        expect(run.usage).toEqual({});
        expect(seen.at(-1)).toMatchObject({
          t: "run-finish",
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    );
  }

  it("does not yield a resolved iterator result after cancellation", async () => {
    const controller = new RunController();
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            const p = Promise.resolve({ done: false as const, value: "late" });
            queueMicrotask(() => queueMicrotask(() => controller.stop()));
            return p;
          },
          async return() {
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const iterator = abortableStream(source, controller.signal)[
      Symbol.asyncIterator
    ]();
    await expect(iterator.next()).rejects.toBeDefined();
  });

  it("does not publish graph output when a model-finish observer stops the run", async () => {
    const { run, events, seen } = setup();
    run.model = {
      async generate() {
        return result;
      },
      async *stream() {},
    };
    events.subscribe((e) => {
      if (e.t === "model-finish") run.stop();
    });
    await run.start();
    await tick();
    expect(run.graph.o.text).toBe("");
    expect(seen.at(-1)).toMatchObject({
      t: "run-finish",
      status: "stopped",
      usage: result.usage,
    });
  });

  it("does not mutate graph output after terminal failure", async () => {
    const { run, seen } = setup();
    run.model = {
      generate: () => {
        const p = Promise.resolve(result);
        cancelAfterResolution(run, false);
        return p;
      },
      async *stream() {},
    };
    await run.start();
    await tick();
    expect(run.usage).toEqual({});
    expect(run.graph.o.text).toBe("");
    expect(run.graph.o.status).not.toBe("complete");
    expect(seen.at(-1)?.t).toBe("run-finish");
  });

  it("rejects a fulfilled first stream event after cancellation and frees its slot", async () => {
    const { run } = setup();
    let closed = 0;
    run.model = {
      async generate() {
        return result;
      },
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                const p = Promise.resolve({
                  done: false as const,
                  value: { type: "text-delta" as const, text: "late" },
                });
                cancelAfterResolution(run, false);
                return p;
              },
              async return() {
                closed++;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    };
    await expect(run.callLLMStream(request)).rejects.toBeDefined();
    expect(closed).toBe(1);
    expect(run.usage).toEqual({});
    expect(await run.llmLimit(async () => "free")).toBe("free");
  });

  it.each(["generate", "goal", "stream"] as const)(
    "run-start cancellation is terminal for direct %s calls",
    async (kind) => {
      const { run, events, seen } = setup();
      let calls = 0;
      const respond = async () => {
        calls++;
        return result;
      };
      const model = {
        generate: respond,
        goal: respond,
        async *stream(): AsyncGenerator<ModelStreamEvent> {
          calls++;
          yield { type: "text-delta", text: "late" };
        },
      };
      run.model = model;
      events.subscribe((e) => {
        if (e.t === "run-start") run.stop();
      });
      const call =
        kind === "generate"
          ? run.callLLM(request)
          : kind === "goal"
            ? run.callGoalAgent({ request })
            : run.callLLMStream(request);
      await expect(call).rejects.toBeDefined();
      expect(calls).toBe(0);
      expect(seen.map((e) => e.t)).toEqual(["run-start", "run-finish"]);
    },
  );

  it("delivers request before nested terminal events to every observer", async () => {
    const { run, events } = setup();
    run.model = {
      async generate() {
        throw new Error("must not call");
      },
      async *stream() {},
    };
    events.subscribe((e) => {
      if (e.t === "model-request") run.stop();
    });
    const later: string[] = [];
    events.subscribe((e) => later.push(e.t));
    await expect(run.callLLM(request)).rejects.toBeDefined();
    expect(later).toEqual([
      "run-start",
      "model-request",
      "model-finish",
      "run-finish",
    ]);
  });
});
