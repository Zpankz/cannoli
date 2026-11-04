// Usage capture: the token counts a provider reports (LangChain usage_metadata,
// streamed or not) are summed per model into the run's stoppage.usage.
import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { LLMProvider, type GenericCompletionParams } from "../../src/providers";
import { Run } from "../../src/run";
import type { TokenUsage } from "../../src/runtime/usage";
import { runCanvas } from "../helpers/run";
import { UsageModel } from "../helpers/usageModel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CallOptions {
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

function reportingLlm() {
  return {
    initialized: true,
    getMergedConfig: () => ({ model: "fake", provider: "ollama" }),
    async getCompletion(_req: GenericCompletionParams, opts?: CallOptions) {
      await sleep(5);
      opts?.onUsage?.({ inputTokens: 10, outputTokens: 5 });
      return { role: "assistant" as const, content: "ok" };
    },
    // Usage arrives with the last chunk, as with ChatOllama's final chunk.
    async getCompletionStream(
      _req: GenericCompletionParams,
      opts?: CallOptions,
    ) {
      async function* chunks() {
        yield "a";
        await sleep(5);
        yield "b";
        opts?.onUsage?.({ inputTokens: 7, outputTokens: 3 });
      }
      return chunks();
    },
  };
}

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

// Three plain calls and one streaming call (green edge into a content node).
const canvas = {
  nodes: [
    ...[0, 1, 2].flatMap((i) => [
      text(`p${i}`, `Prompt ${i}`, 0, i * 200, "6"),
      text(`c${i}`, "", 300, i * 200),
      text(`o${i}`, "", 600, i * 200, "6"),
    ]),
    text("sp", "Stream prompt", 0, 600, "6"),
    text("sc", "", 300, 600),
    text("so", "", 600, 600, "6"),
  ],
  edges: [
    ...[0, 1, 2].flatMap((i) => [
      edge(`e${i}a`, `p${i}`, `c${i}`),
      edge(`e${i}b`, `c${i}`, `o${i}`),
    ]),
    edge("sa", "sp", "sc"),
    edge("sb", "sc", "so", "4"),
  ],
};

describe("usage", () => {
  it("provider reports LangChain usage_metadata, streamed or not", async () => {
    const llm = new LLMProvider({
      configs: [{ provider: "ollama", model: "fake" }],
    });
    llm.getChatClient = () => new UsageModel();
    const messages = [{ role: "user", content: "hi" }];

    const reported: TokenUsage[] = [];
    const onUsage = (u: TokenUsage) => reported.push(u);

    const completion = await llm.getCompletion({ messages }, { onUsage });
    expect(completion.content).toBe("hello");

    let streamed = "";
    for await (const part of await llm.getCompletionStream(
      { messages },
      { onUsage },
    )) {
      streamed += part;
    }
    expect(streamed).toBe("hello");

    expect(reported).toEqual([
      { inputTokens: 4, outputTokens: 2 },
      { inputTokens: 6, outputTokens: 3 },
    ]);
  });

  it("a stream stopped early still reports the usage already received", async () => {
    const llm = new LLMProvider({
      configs: [{ provider: "ollama", model: "fake" }],
    });
    // Input tokens arrive on the first chunk, as some providers send them.
    llm.getChatClient = () =>
      ({
        stream: async () =>
          (async function* () {
            yield new AIMessageChunk({
              content: "Once ",
              usage_metadata: { input_tokens: 9, output_tokens: 0, total_tokens: 9 },
            });
            yield new AIMessageChunk({ content: "upon" });
          })(),
      }) as unknown as ReturnType<LLMProvider["getChatClient"]>;

    const reported: TokenUsage[] = [];
    const stream = await llm.getCompletionStream(
      { messages: [{ role: "user", content: "hi" }] },
      { onUsage: (u) => reported.push(u) },
    );
    for await (const _ of stream) break; // the consumer stops after one chunk

    expect(reported.at(-1)).toEqual({ inputTokens: 9, outputTokens: 0 });
  });

  it("usage summed per run", async () => {
    const { finished, stoppages } = await runCanvas(canvas, {
      isMock: false,
      beforeStart: (r) => {
        r.llm = reportingLlm() as unknown as Run["llm"];
      },
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(stoppages[0].usage).toEqual({
      fake: { numberOfCalls: 4, promptTokens: 37, completionTokens: 18 },
    });
  });
});
