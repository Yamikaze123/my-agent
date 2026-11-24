// Small fetch helpers shared by the finance UI: JSON error extraction and a
// request wrapper that cannot hang forever.

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const ANALYSIS_REQUEST_TIMEOUT_MS = 60_000;

export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

// The API reports failures as JSON such as {"error": "...", "code": "..."}.
export function responseError(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.trim()
  ) {
    return payload.error;
  }
  return fallback;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export type JsonResponse = {
  ok: boolean;
  status: number;
  // undefined when the body was empty or not JSON.
  payload: unknown;
};

type RequestJsonOptions = RequestInit & {
  timeoutMs?: number;
  timeoutMessage?: string;
  fetchImpl?: typeof fetch;
};

// Fetches and reads a JSON body under one deadline. Rejects with
// RequestTimeoutError when the deadline passes, and with an AbortError when
// the caller's own signal aborts (for example on unmount).
export async function requestJson(
  url: string,
  {
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    timeoutMessage = "The request took too long and was cancelled. Please try again.",
    fetchImpl = fetch,
    signal: callerSignal,
    ...init
  }: RequestJsonOptions = {},
): Promise<JsonResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    if (controller.signal.aborted) {
      throw new DOMException("The request was aborted.", "AbortError");
    }
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      payload = undefined;
    }
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(timeoutMessage);
    if (controller.signal.aborted) {
      throw new DOMException("The request was aborted.", "AbortError");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
