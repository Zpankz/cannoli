import { describe, expect, it, vi } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { makeObsidianFetch } from "../src/fetch";

function nativeResponse(status = 200) {
  return {
    status,
    headers: { "content-type": "text/plain" },
    text: "buffered",
    arrayBuffer: new TextEncoder().encode("buffered").buffer,
    json: {},
  };
}
function setup() {
  const requestUrl = vi.fn(async (_request: RequestUrlParam) =>
    nativeResponse(),
  );
  const windowFetch = vi.fn<typeof fetch>(async () => new Response("streamed"));
  const onStreamingUnavailable = vi.fn();
  return {
    requestUrl,
    windowFetch,
    onStreamingUnavailable,
    fetch: makeObsidianFetch({
      requestUrl,
      windowFetch,
      onStreamingUnavailable,
    }),
  };
}
const url = "https://example.test/v1";
const streaming = { method: "POST", body: JSON.stringify({ stream: true }) };

describe("Obsidian model fetch", () => {
  it("streams through window.fetch", async () => {
    const s = setup();
    expect(await (await s.fetch(url, streaming)).text()).toBe("streamed");
    expect(s.requestUrl).not.toHaveBeenCalled();
  });
  it("falls back on TypeError and flags buffered streaming", async () => {
    const s = setup();
    s.windowFetch.mockRejectedValue(new TypeError("CORS"));
    expect(await (await s.fetch(url, streaming)).text()).toBe("buffered");
    expect(s.requestUrl).toHaveBeenCalledTimes(1);
    expect(s.onStreamingUnavailable).toHaveBeenCalledTimes(1);
  });
  it("does not retry other streaming errors", async () => {
    const s = setup();
    s.windowFetch.mockRejectedValue(new Error("failed"));
    await expect(s.fetch(url, streaming)).rejects.toThrow("failed");
    expect(s.requestUrl).not.toHaveBeenCalled();
  });
  it("uses requestUrl for buffered calls and preserves HTTP errors", async () => {
    const s = setup();
    s.requestUrl.mockResolvedValue(nativeResponse(429));
    const response = await s.fetch(url, { method: "POST", body: "{}" });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("buffered");
    expect(s.requestUrl.mock.calls[0][0]).toMatchObject({ url, throw: false });
    expect(
      new TextDecoder().decode(
        s.requestUrl.mock.calls[0][0].body as ArrayBuffer,
      ),
    ).toBe("{}");
    expect(s.windowFetch).not.toHaveBeenCalled();
  });
  it("sets the Anthropic header for both transports", async () => {
    const s = setup();
    await s.fetch("https://api.anthropic.com/v1/messages");
    expect(s.requestUrl.mock.calls[0][0].headers).toMatchObject({
      "anthropic-dangerous-direct-browser-access": "true",
    });
    await s.fetch("https://api.anthropic.com/v1/messages", streaming);
    expect(
      new Headers(s.windowFetch.mock.calls[0][1]?.headers).get(
        "anthropic-dangerous-direct-browser-access",
      ),
    ).toBe("true");
  });
  it("rejects pre-aborted signals without sending", async () => {
    const s = setup();
    await expect(
      s.fetch(url, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(s.requestUrl).not.toHaveBeenCalled();
    expect(s.windowFetch).not.toHaveBeenCalled();
  });
  it("rejects promptly during an uncancellable requestUrl call", async () => {
    const s = setup();
    s.requestUrl.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const response = s.fetch(url, { signal: controller.signal });
    await vi.waitFor(() => expect(s.requestUrl).toHaveBeenCalledOnce());
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
  });
  it("checks egress before sending and supports Request inputs", async () => {
    const s = setup();
    const isAllowed = vi.fn(() => false);
    await expect(makeObsidianFetch({ ...s, isAllowed })(url)).rejects.toThrow(
      /not allowed/i,
    );
    expect(s.requestUrl).not.toHaveBeenCalled();
    await s.fetch(new Request(url, streaming));
    expect(s.windowFetch).toHaveBeenCalledOnce();
  });
});
