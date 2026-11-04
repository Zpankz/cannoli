import { requestUrl as obsidianRequestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export interface ObsidianFetchOptions {
  stream?: boolean;
  requestUrl?: (request: RequestUrlParam) => Promise<RequestUrlResponse>;
  windowFetch?: typeof fetch;
  isAllowed?: (url: string) => boolean | Promise<boolean>;
  onStreamingUnavailable?: (url: string) => void;
}

/** Allow-all seam until the network policy phase; cancellation applies now. */
export function checkEgress(url: string, signal?: AbortSignal | null): void {
  new URL(url);
  signal?.throwIfAborted();
}

/** requestUrl cannot cancel its native I/O; detach the caller on abort. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Browser fetch preserves streaming; native requestUrl bypasses CORS when needed. */
export function makeObsidianFetch(
  options: ObsidianFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const { url, signal } = request;
    checkEgress(url, signal);
    if (options.isAllowed && !(await options.isAllowed(url))) {
      throw new Error(`Network request not allowed: ${url}`);
    }
    signal.throwIfAborted();
    const headers = new Headers(request.headers);
    if (new URL(url).hostname === "api.anthropic.com") {
      headers.set("anthropic-dangerous-direct-browser-access", "true");
    }
    const body = request.body ? await request.arrayBuffer() : undefined;
    signal.throwIfAborted();
    const endpoint = new URL(url);
    let stream =
      options.stream ??
      (endpoint.pathname.endsWith(":streamGenerateContent") &&
        endpoint.searchParams.get("alt") === "sse");
    if (options.stream === undefined && body) {
      try {
        stream ||= JSON.parse(new TextDecoder().decode(body)).stream === true;
      } catch {
        // URL-based streaming does not require a JSON stream flag.
      }
    }
    if (stream) {
      const browserFetch = options.windowFetch ?? window.fetch.bind(window);
      try {
        return await browserFetch(url, {
          ...init,
          method: request.method,
          headers,
          body,
          signal,
        });
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof TypeError)) throw error;
        options.onStreamingUnavailable?.(url);
      }
    }
    const nativeRequest = options.requestUrl ?? obsidianRequestUrl;
    const nativeHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      nativeHeaders[name] = value;
    });
    const response = await abortable(
      nativeRequest({
        url,
        method: request.method,
        headers: nativeHeaders,
        body,
        throw: false,
      }),
      signal,
    );
    signal.throwIfAborted();
    // Fetch forbids bodies on these statuses, even an empty buffer.
    return new Response(
      [101, 204, 205, 304].includes(response.status)
        ? null
        : response.arrayBuffer,
      {
        status: response.status,
        headers: response.headers,
      },
    );
  };
}
