import type { ResolvedPermissionContext } from "./permission-context";

/**
 * Fixed-window request limits for the public API routes.
 *
 * Every visitor receives a server-issued anonymous session, so a per-session
 * limit alone is bypassed by discarding the cookie. Each action is therefore
 * counted against both the session's resource and the client address, and
 * minting a new session is itself limited per address.
 *
 * State is held in this process. On a multi-instance deployment each instance
 * enforces its own counters, so the effective ceiling is the limit multiplied
 * by the instance count; a shared store is required for a strict global limit.
 * The client address comes from the proxy's X-Forwarded-For header and is only
 * as trustworthy as the proxy in front of the application.
 */
export type RateLimitAction =
  | "session:create"
  | "chat:send"
  | "chat:read"
  | "dataset:read"
  | "dataset:write"
  | "analysis:run";

type Limit = { windowMs: number; perResource: number; perClient: number };

const MINUTE_MS = 60_000;

export const RATE_LIMITS: Readonly<Record<RateLimitAction, Limit>> =
  Object.freeze({
    // A new anonymous session is issued whenever a request arrives without a
    // session cookie. There is no resource yet, so only the address is counted.
    "session:create": {
      windowMs: 10 * MINUTE_MS,
      perResource: Number.POSITIVE_INFINITY,
      perClient: 30,
    },
    // Each chat turn can spend model tokens and start a code sandbox.
    "chat:send": { windowMs: MINUTE_MS, perResource: 12, perClient: 30 },
    "chat:read": { windowMs: MINUTE_MS, perResource: 60, perClient: 120 },
    "dataset:read": { windowMs: MINUTE_MS, perResource: 60, perClient: 120 },
    "dataset:write": { windowMs: MINUTE_MS, perResource: 12, perClient: 30 },
    "analysis:run": { windowMs: MINUTE_MS, perResource: 30, perClient: 60 },
  });

const MAX_TRACKED_KEYS = 50_000;

type Window = { startedAt: number; count: number };

declare global {
  var requestRateLimitWindows: Map<string, Window> | undefined;
}

function windows(): Map<string, Window> {
  globalThis.requestRateLimitWindows ??= new Map();
  return globalThis.requestRateLimitWindows;
}

/** Clear all counters. Intended for tests. */
export function resetRateLimits(): void {
  globalThis.requestRateLimitWindows = undefined;
}

function prune(state: Map<string, Window>, now: number): void {
  const longestWindow = Math.max(
    ...Object.values(RATE_LIMITS).map((limit) => limit.windowMs),
  );
  for (const [key, window] of state) {
    if (now - window.startedAt >= longestWindow) state.delete(key);
  }
  // If a flood of distinct keys still exceeds the bound, drop the oldest
  // entries (Map preserves insertion order) rather than grow without limit.
  for (const key of state.keys()) {
    if (state.size <= MAX_TRACKED_KEYS) break;
    state.delete(key);
  }
}

/** Returns 0 when the request is allowed, else milliseconds until reset. */
function consume(
  state: Map<string, Window>,
  key: string,
  max: number,
  windowMs: number,
  now: number,
): number {
  if (!Number.isFinite(max)) return 0;
  const current = state.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    state.delete(key);
    state.set(key, { startedAt: now, count: 1 });
    return 0;
  }
  if (current.count >= max) return current.startedAt + windowMs - now;
  current.count += 1;
  return 0;
}

export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",", 1)[0]?.trim();
  const address = first || request.headers.get("x-real-ip")?.trim() || "";
  // Bound the key so a crafted header cannot inflate memory use.
  return address ? address.slice(0, 64) : "unknown";
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function checkRateLimit(
  action: RateLimitAction,
  keys: { resourceId?: string; client: string },
  now = Date.now(),
): RateLimitDecision {
  const limit = RATE_LIMITS[action];
  const state = windows();
  if (state.size > MAX_TRACKED_KEYS) prune(state, now);

  const waits = [
    keys.resourceId
      ? consume(
          state,
          `${action}:resource:${keys.resourceId}`,
          limit.perResource,
          limit.windowMs,
          now,
        )
      : 0,
    consume(
      state,
      `${action}:client:${keys.client}`,
      limit.perClient,
      limit.windowMs,
      now,
    ),
  ];
  const wait = Math.max(...waits);
  return wait > 0
    ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) }
    : { allowed: true };
}

/**
 * Apply the limits for one route action. A request that mints a new session
 * is first counted against the per-address session limit, so discarding the
 * cookie does not reset the per-session allowance without cost.
 */
export function enforceRateLimit(
  request: Request,
  resolved: ResolvedPermissionContext,
  action: Exclude<RateLimitAction, "session:create">,
  now = Date.now(),
): RateLimitDecision {
  const client = clientAddress(request);
  if (resolved.sessionCookie) {
    const session = checkRateLimit("session:create", { client }, now);
    if (!session.allowed) return session;
  }
  return checkRateLimit(
    action,
    { resourceId: resolved.permissionContext.resource.id, client },
    now,
  );
}

/**
 * The 429 response for a limited request. No session cookies are attached:
 * a refused request must not hand out the session it was refused for.
 */
export function rateLimitResponse(
  decision: Extract<RateLimitDecision, { allowed: false }>,
): Response {
  return Response.json(
    {
      error: `Too many requests. Please wait ${decision.retryAfterSeconds} second${decision.retryAfterSeconds === 1 ? "" : "s"} and try again.`,
      code: "rate_limited",
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(decision.retryAfterSeconds),
      },
    },
  );
}
