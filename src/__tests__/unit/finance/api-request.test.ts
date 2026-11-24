import { describe, expect, it, vi } from "vitest";
import {
  RequestTimeoutError,
  isAbortError,
  requestJson,
  responseError,
} from "@/components/finance/api-request";
import {
  financeAnalysisFromOutput,
  toolOutputImages,
  toolOutputRecord,
} from "@/components/finance/tool-output";

// A fetch that never answers but honours the abort signal, like a hung route.
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });

describe("responseError", () => {
  it("prefers the API error text and falls back otherwise", () => {
    expect(responseError({ error: "Too many requests." }, "fallback")).toBe(
      "Too many requests.",
    );
    expect(responseError({ error: "  " }, "fallback")).toBe("fallback");
    expect(responseError(undefined, "fallback")).toBe("fallback");
    expect(responseError("text", "fallback")).toBe("fallback");
  });
});

describe("requestJson", () => {
  it("returns status and parsed payload for non-OK responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "Slow down." }), {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
    );
    const result = await requestJson("/api/analysis", { fetchImpl });

    expect(result).toEqual({
      ok: false,
      status: 429,
      payload: { error: "Slow down." },
    });
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("yields an undefined payload when the body is not JSON", async () => {
    const result = await requestJson("/api/datasets", {
      fetchImpl: async () => new Response("<html>", { status: 502 }),
    });
    expect(result).toEqual({ ok: false, status: 502, payload: undefined });
  });

  it("rejects with a timeout error when the request hangs", async () => {
    const request = requestJson("/api/analysis", {
      fetchImpl: hangingFetch,
      timeoutMs: 5,
      timeoutMessage: "Took too long.",
    });
    await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(request).rejects.toThrow("Took too long.");
  });

  it("rejects with an abort error when the caller aborts", async () => {
    const controller = new AbortController();
    const request = requestJson("/api/analysis", {
      fetchImpl: hangingFetch,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();

    const error = await request.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
  });

  it("does not start a request for an already aborted signal", async () => {
    const error = await requestJson("/api/datasets", {
      fetchImpl: hangingFetch,
      signal: AbortSignal.abort(),
    }).catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
  });
});

describe("tool output helpers", () => {
  it("reads objects and JSON strings alike", () => {
    expect(toolOutputRecord({ images: ["a"] })).toEqual({ images: ["a"] });
    expect(toolOutputRecord('{"images":["a"]}')).toEqual({ images: ["a"] });
    expect(toolOutputRecord("plain text")).toBeUndefined();
    expect(toolOutputRecord("[1,2]")).toBeUndefined();
    expect(toolOutputRecord(null)).toBeUndefined();
  });

  it("extracts chart images from either form", () => {
    expect(toolOutputImages({ images: ["abc", 3, ""] })).toEqual(["abc"]);
    expect(toolOutputImages('{"images":["abc"]}')).toEqual(["abc"]);
    expect(toolOutputImages({ images: "abc" })).toEqual([]);
    expect(toolOutputImages(undefined)).toEqual([]);
  });

  it("only recognises valid finance analysis results", () => {
    expect(financeAnalysisFromOutput({ images: [] })).toBeUndefined();
    expect(financeAnalysisFromOutput("not json")).toBeUndefined();
  });
});
