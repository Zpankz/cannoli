import { describe, expect, it, vi } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { AiSdkModelPort } from "@deablabs/cannoli-core";
import { makeObsidianFetch } from "../src/fetch";

const encoder = new TextEncoder();
const chunk = (text: string, final = false) =>
  encoder.encode(
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, ...(final ? { finishReason: "STOP" } : {}) }], ...(final ? { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } } : {}) })}\n\n`,
  );

describe("Google SDK through Obsidian fetch", () => {
  it.each([undefined, false] as const)(
    "honors URL streaming and explicit stream=%s",
    async (stream) => {
      let finish: () => void = () => {};
      const browser = vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(chunk("first"));
                finish = () => {
                  controller.enqueue(chunk("last", true));
                  controller.close();
                };
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const native = vi.fn(async (_request: RequestUrlParam) => {
        const data = chunk("buffered", true);
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          arrayBuffer: data.buffer as ArrayBuffer,
          text: "",
          json: {},
        };
      });
      const port = new AiSdkModelPort({
        providers: [
          {
            id: "google",
            kind: "google",
            apiKey: "test",
            baseURL: "https://gateway.test/v1beta?tenant=demo",
          },
        ],
        fetch: makeObsidianFetch({
          stream,
          windowFetch: browser,
          requestUrl: native,
        }),
      });
      const events = port.stream({
        model: "google:gemini-3.8-flash",
        messages: [{ role: "user", content: "Hi" }],
        signal: new AbortController().signal,
      });
      const first = await events.next();
      expect(first.value).toMatchObject({
        type: "text-delta",
        text: stream === false ? "buffered" : "first",
      });
      if (stream === undefined) {
        expect(native).not.toHaveBeenCalled();
        const url = new URL(String(browser.mock.calls[0][0]));
        expect(url.pathname).toBe(
          "/v1beta/models/gemini-3.8-flash:streamGenerateContent",
        );
        expect(url.searchParams.get("alt")).toBe("sse");
        expect(url.searchParams.get("tenant")).toBe("demo");
        expect(
          JSON.parse(
            new TextDecoder().decode(
              browser.mock.calls[0][1]?.body as ArrayBuffer,
            ),
          ).stream,
        ).toBeUndefined();
        finish();
      } else expect(browser).not.toHaveBeenCalled();
      const remaining = [];
      for await (const event of events) remaining.push(event);
      expect(remaining.at(-1)?.type).toBe("finish");
    },
  );

  it("flags Google CORS fallback and leaves non-stream Google requests buffered", async () => {
    const windowFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError("CORS");
    });
    const requestUrl = vi.fn(async (_request: RequestUrlParam) => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: {},
    }));
    const onStreamingUnavailable = vi.fn();
    const fetch = makeObsidianFetch({
      windowFetch,
      requestUrl,
      onStreamingUnavailable,
    });
    await fetch(
      "https://gateway.test/models/gemini:streamGenerateContent?alt=sse",
      { method: "POST", body: "{}" },
    );
    expect(windowFetch).toHaveBeenCalledOnce();
    expect(onStreamingUnavailable).toHaveBeenCalledOnce();
    await fetch("https://gateway.test/models/gemini:generateContent", {
      method: "POST",
      body: "{}",
    });
    expect(windowFetch).toHaveBeenCalledOnce();
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });
});
