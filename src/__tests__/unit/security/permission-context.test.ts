import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationError,
  ConfigurationError,
  createMastraRequestContext,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";

function request(cookie?: string): Request {
  return new Request("http://localhost/api/chat", {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("server-controlled permission context", () => {
  it("creates distinct principals, resources, and threads", () => {
    const first = resolvePermissionContext(request());
    const second = resolvePermissionContext(request());

    expect(first.permissionContext.principal.id).not.toBe(
      second.permissionContext.principal.id,
    );
    expect(first.permissionContext.resource.id).not.toBe(
      second.permissionContext.resource.id,
    );
    expect(first.permissionContext.thread.id).not.toBe(
      second.permissionContext.thread.id,
    );
  });

  it("rejects a thread cookie presented with another session", () => {
    const first = resolvePermissionContext(request());
    const second = resolvePermissionContext(request());
    const firstSession = first.sessionCookie ?? "";
    const secondThread = second.threadCookie ?? "";

    expect(() =>
      resolvePermissionContext(
        request(`session_id=${firstSession}; thread_id=${secondThread}`),
      ),
    ).toThrow(AuthorizationError);
  });

  it("rejects tampered and unsigned thread cookies", () => {
    const resolved = resolvePermissionContext(request());
    const session = resolved.sessionCookie ?? "";
    const thread = resolved.threadCookie ?? "";
    const tampered = `${thread.slice(0, -1)}${thread.endsWith("a") ? "b" : "a"}`;

    expect(() =>
      resolvePermissionContext(
        request(`session_id=${session}; thread_id=${tampered}`),
      ),
    ).toThrow(AuthorizationError);
    expect(() =>
      resolvePermissionContext(
        request(`session_id=${session}; thread_id=plain-id`),
      ),
    ).toThrow(AuthorizationError);
  });

  it("places server-controlled IDs in Mastra reserved request-context keys", () => {
    const resolved = resolvePermissionContext(request());
    const context = createMastraRequestContext(resolved.permissionContext);

    expect(context.toJSON()).toMatchObject({
      mastra__resourceId: resolved.permissionContext.resource.id,
      mastra__threadId: resolved.permissionContext.thread.id,
      permissionContext: resolved.permissionContext,
    });
  });

  it("requires a signing secret outside the test environment", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SIGNING_SECRET", "");

    try {
      expect(() => resolvePermissionContext(request())).toThrow(
        ConfigurationError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
