import { describe, expect, it } from "vitest";
import { AiSdkModelPort } from "../../src/model/ai-sdk/adapter";
import type { GenerateRequest } from "../../src/model/types";
import { chatCompletion, fakeFetch, jsonResponse } from "../helpers/fakeFetch";

const providers = [
  { id: "ollama", kind: "ollama" as const, baseURL: "http://localhost:11434" },
];
const request = (): GenerateRequest => ({
  model: "ollama:test",
  messages: [{ role: "user", content: "synthetic" }],
  signal: new AbortController().signal,
});
const retryable = (status: number) =>
  new Response(
    JSON.stringify({ error: { message: "Synthetic provider failure" } }),
    {
      status,
      headers: { "content-type": "application/json", "retry-after": "0" },
    },
  );

describe("AI SDK retry authority", () => {
  for (const status of [429, 503]) {
    it(`generate does not automatically replay HTTP ${status}`, async () => {
      const { fetch, requests } = fakeFetch(() => retryable(status));
      const port = new AiSdkModelPort({ providers, fetch });
      await expect(port.generate(request())).rejects.toThrow();
      expect(requests).toHaveLength(1);
    }, 20000);
    it(`stream does not automatically replay HTTP ${status}`, async () => {
      const { fetch, requests } = fakeFetch(() => retryable(status));
      const port = new AiSdkModelPort({ providers, fetch });
      const events = [];
      for await (const event of port.stream(request())) events.push(event);
      expect(requests).toHaveLength(1);
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    }, 20000);
  }
  it("does not replay an ambiguous transport rejection", async () => {
    const { fetch, requests } = fakeFetch(() => {
      throw new TypeError("Synthetic connection loss after dispatch");
    });
    const port = new AiSdkModelPort({ providers, fetch });
    await expect(port.generate(request())).rejects.toThrow();
    expect(requests).toHaveLength(1);
  }, 20000);
  it("permits an explicit bounded retry policy", async () => {
    const { fetch, requests } = fakeFetch(() =>
      requests.length === 1
        ? retryable(503)
        : jsonResponse(chatCompletion({ content: "recovered" })),
    );
    const port = new AiSdkModelPort({ providers, fetch, maxRetries: 1 });
    expect((await port.generate(request())).text).toBe("recovered");
    expect(requests).toHaveLength(2);
  }, 20000);
  it("honors the exact explicit retry ceiling on persistent failures", async () => {
    const { fetch, requests } = fakeFetch(() => retryable(503));
    const port = new AiSdkModelPort({ providers, fetch, maxRetries: 1 });
    await expect(port.generate(request())).rejects.toThrow();
    expect(requests).toHaveLength(2);
  }, 20000);
  it("honors explicit stream retry limits", async () => {
    const { fetch, requests } = fakeFetch(() => retryable(503));
    const port = new AiSdkModelPort({ providers, fetch, maxRetries: 1 });
    const events = [];
    for await (const event of port.stream(request())) events.push(event);
    expect(requests).toHaveLength(2);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  }, 20000);
  it("abort prevents a caller-authorized retry from dispatching", async () => {
    const controller = new AbortController();
    const { fetch, requests } = fakeFetch(() => {
      controller.abort(new Error("Stopped after first dispatch"));
      return retryable(503);
    });
    const port = new AiSdkModelPort({ providers, fetch, maxRetries: 1 });
    await expect(
      port.generate({ ...request(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  }, 20000);
  it("rejects invalid retry budgets before any request", () => {
    const { fetch, requests } = fakeFetch(() => retryable(503));
    for (const maxRetries of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        () => new AiSdkModelPort({ providers, fetch, maxRetries }),
      ).toThrow("maxRetries");
    expect(requests).toHaveLength(0);
  });
});
