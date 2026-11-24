import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  clientAddress,
  enforceRateLimit,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/mastra/security/rate-limit";
import { resolvePermissionContext } from "@/mastra/security/permission-context";

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", { headers });
}

describe("request rate limits", () => {
  it("allows up to the per-resource limit and then refuses until the window resets", () => {
    const limit = RATE_LIMITS["chat:send"];
    const keys = { resourceId: "resource-a", client: "203.0.113.1" };
    const now = 1_000_000;

    for (let index = 0; index < limit.perResource; index += 1) {
      expect(checkRateLimit("chat:send", keys, now + index)).toEqual({
        allowed: true,
      });
    }
    const refused = checkRateLimit("chat:send", keys, now + 1_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 59 });

    expect(checkRateLimit("chat:send", keys, now + limit.windowMs + 1)).toEqual(
      { allowed: true },
    );
  });

  it("counts resources separately but shares the client address limit", () => {
    const limit = RATE_LIMITS["chat:send"];
    const client = "203.0.113.2";
    const now = 2_000_000;

    // Fresh sessions from one address each have their own allowance, but
    // together they cannot exceed the address limit.
    let allowed = 0;
    for (let index = 0; index < limit.perClient + 5; index += 1) {
      const decision = checkRateLimit(
        "chat:send",
        { resourceId: `resource-${index}`, client },
        now,
      );
      if (decision.allowed) allowed += 1;
    }
    expect(allowed).toBe(limit.perClient);

    expect(
      checkRateLimit(
        "chat:send",
        { resourceId: "other", client: "203.0.113.3" },
        now,
      ),
    ).toEqual({ allowed: true });
  });

  it("limits how many new sessions one address can mint", () => {
    const limit = RATE_LIMITS["session:create"];
    const headers = { "x-forwarded-for": "203.0.113.4" };
    const now = 3_000_000;

    for (let index = 0; index < limit.perClient; index += 1) {
      // No cookie: every request resolves to a newly issued session.
      const resolved = resolvePermissionContext(request(headers));
      expect(
        enforceRateLimit(request(headers), resolved, "dataset:read", now),
      ).toEqual({ allowed: true });
    }

    const resolved = resolvePermissionContext(request(headers));
    expect(
      enforceRateLimit(request(headers), resolved, "dataset:read", now),
    ).toMatchObject({ allowed: false });
  });

  it("reads the first forwarded address and bounds its length", () => {
    expect(
      clientAddress(request({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" })),
    ).toBe("198.51.100.7");
    expect(clientAddress(request())).toBe("unknown");
    expect(
      clientAddress(request({ "x-forwarded-for": "a".repeat(500) })),
    ).toHaveLength(64);
  });

  it("returns a 429 with Retry-After and no session cookie", async () => {
    const response = rateLimitResponse({
      allowed: false,
      retryAfterSeconds: 42,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "rate_limited",
    });
  });
});
