// Cancellation (DESIGN §11.2): a RunController's signal reaches every model
// call and run-path fetch, and stopping keeps what was already streamed.
import { describe, expect, it } from "vitest";
import { CannoliObjectStatus } from "../../src/graph";
import type { Persistor } from "../../src/persistor";
import { LLMProvider, type GenericCompletionParams } from "../../src/providers";
import { Run } from "../../src/run";
import { RunController } from "../../src/runtime/controller";
import { runCanvas } from "../helpers/run";
import { UsageModel } from "../helpers/usageModel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves when the signal aborts; never resolves otherwise. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const box = { width: 200, height: 100 };
const text = (id: string, t: string, x: number, y: number, color?: string) => ({
  id,
  type: "text",
  text: t,
  x,
  y,
  ...box,
  ...(color ? { color } : {}),
});
const edge = (id: string, fromNode: string, toNode: string, color?: string) => ({
  id,
  fromNode,
  fromSide: "right",
  toNode,
  toSide: "left",
  ...(color ? { color } : {}),
});

// prompt → call → output
const oneCall = {
  nodes: [
    text("p", "Write a long story.", 0, 0, "6"),
    text("c", "", 300, 0),
    text("o", "", 600, 0, "6"),
  ],
  edges: [edge("e1", "p", "c"), edge("e2", "c", "o")],
};

// prompt → call ⇒ content, over a green (chat-response) edge, so it streams
const streamingCall = {
  nodes: [
    text("p", "Write a long story.", 0, 0, "6"),
    text("c", "", 300, 0),
    text("o", "", 600, 0, "6"),
  ],
  edges: [edge("e1", "p", "c"), edge("e2", "c", "o", "4")],
};

// an HTTP node (orange) feeding an output node
const httpCall = {
  nodes: [
    text("h", "https://example.test/slow", 0, 0, "2"),
    text("o", "", 300, 0, "6"),
  ],
  edges: [edge("e1", "h", "o")],
};

const request: GenericCompletionParams = {
  messages: [{ role: "user", content: "hi" }],
  model: "fake",
};

interface CallOptions {
  signal?: AbortSignal;
}

/** A provider whose calls hang until their signal aborts. */
function hangingLlm() {
  const seen: { signals: (AbortSignal | undefined)[] } = { signals: [] };
  const llm = {
    initialized: true,
    getMergedConfig: () => ({ model: "fake", provider: "ollama" }),
    async getCompletion(_req: GenericCompletionParams, opts?: CallOptions) {
      seen.signals.push(opts?.signal);
      if (opts?.signal) await aborted(opts.signal);
      else await new Promise(() => {});
      throw new DOMException("The operation was aborted.", "AbortError");
    },
    // Streams a few chunks, then hangs (ignoring the signal) as if the
    // model were still generating.
    async getCompletionStream(
      _req: GenericCompletionParams,
      opts?: CallOptions,
    ) {
      seen.signals.push(opts?.signal);
      async function* chunks() {
        for (const part of ["Once ", "upon ", "a time"]) {
          await sleep(5);
          yield part;
        }
        await new Promise(() => {});
      }
      return chunks();
    },
  };
  return { llm, seen };
}

const stopAfter = (ms: number) => async (run: Run) => {
  await sleep(ms);
  run.stop();
};

describe("controller", () => {
  it("stop aborts in-flight model call", async () => {
    const { llm, seen } = hangingLlm();
    const controller = new RunController();
    const { finished, stoppages, run } = await runCanvas(oneCall, {
      isMock: false,
      runArgs: { controller },
      beforeStart: (r) => {
        r.llm = llm as unknown as Run["llm"];
      },
      afterStart: async () => {
        await sleep(30);
        controller.stop();
      },
    });

    expect(finished).toBe(true);
    expect(seen.signals).toHaveLength(1);
    expect(seen.signals[0]).toBeInstanceOf(AbortSignal);
    expect(seen.signals[0]?.aborted).toBe(true);
    // A user stop, not an error caused by the aborted call.
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
    expect(run.graph.c.status).toBe(CannoliObjectStatus.Warning);
  });

  it("stopped run marks executing nodes warning and keeps partial text", async () => {
    const { llm } = hangingLlm();
    const warnings: [string, string][] = [];
    const errors: [string, string][] = [];
    const persistor: Persistor = {
      start: async () => {},
      editNode: async () => {},
      editEdge: async () => {},
      addError: async (id, msg) => {
        errors.push([id, msg]);
      },
      addWarning: async (id, msg) => {
        warnings.push([id, msg]);
      },
      editOriginalParallelGroupLabel: async () => {},
      setConfig: () => {},
    };
    const { finished, stoppages, run } = await runCanvas(streamingCall, {
      isMock: false,
      runArgs: { persistor },
      beforeStart: (r) => {
        r.llm = llm as unknown as Run["llm"];
      },
      afterStart: stopAfter(60),
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
    expect(run.graph.c.status).toBe(CannoliObjectStatus.Warning);
    expect(warnings.map(([id]) => id)).toEqual(["c"]);
    expect(warnings[0][1]).toMatch(/stopped/i);
    expect(errors).toEqual([]);
    // Every streamed chunk is kept, in order, after the assistant header.
    expect(run.graph.o.text).toContain("Once upon a time");
    // The stream never finished, so no "User" template was appended.
    expect(run.graph.o.text).not.toContain("User");
  });

  it("a stream abort frees its pLimit slot", async () => {
    const { llm } = hangingLlm();
    const run = new Run({
      cannoli: oneCall,
      isMock: false,
      config: { pLimit: 1 },
    });
    run.llm = llm as unknown as Run["llm"];

    const stream = await run.callLLMStream(request);
    if (stream instanceof Error || typeof stream === "string") {
      throw new Error(`expected a stream, got ${String(stream)}`);
    }
    // Consume in the background: the stream hangs after three chunks.
    const consumed = (async () => {
      let out = "";
      try {
        for await (const part of stream) out += part;
      } catch {
        // an aborted stream may end by throwing
      }
      return out;
    })();
    await sleep(40);

    run.stop();

    // The one slot is free again: queued work proceeds instead of hanging.
    const fresh = await Promise.race([
      run.llmLimit(async () => "fresh"),
      sleep(500).then(() => "slot still held"),
    ]);
    expect(fresh).toBe("fresh");
    // And the consumer's loop ends with the partial text.
    const out = await Promise.race([consumed, sleep(500).then(() => "hung")]);
    expect(out).toBe("Once upon a time");
  });

  it("provider passes the signal to LangChain", async () => {
    const model = new UsageModel();
    const llm = new LLMProvider({
      configs: [{ provider: "ollama", model: "fake" }],
    });
    llm.getChatClient = () => model;
    const { signal } = new RunController();
    const messages = [{ role: "user", content: "hi" }];

    await llm.getCompletion({ messages }, { signal });
    await llm.getCompletion(
      {
        messages,
        functions: [{ name: "choice", parameters: {} }],
        function_call: { name: "choice" },
      },
      { signal },
    );
    for await (const _ of await llm.getCompletionStream({ messages }, { signal })) {
      // drain
    }

    expect(model.signals).toEqual([signal, signal, signal]);
  });

  it("HttpNode fetch receives the signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const { finished, stoppages, run } = await runCanvas(httpCall, {
      isMock: false,
      runArgs: {
        fetcher: async (_url, options) => {
          signals.push(options.signal);
          // Like Obsidian's requestUrl: ignores the signal entirely.
          return new Promise<string>(() => {});
        },
      },
      afterStart: stopAfter(30),
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(true);
    expect(run.graph.h.status).toBe(CannoliObjectStatus.Warning);
  });
});
