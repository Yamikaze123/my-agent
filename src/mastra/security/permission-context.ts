import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { z } from "zod";

const SESSION_COOKIE = "session_id";
const THREAD_COOKIE = "thread_id";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const TEST_SIGNING_SECRET =
  "test-only-session-signing-secret-do-not-use-outside-tests";

const sessionPayloadSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.uuid(),
    principalId: z.uuid(),
    resourceId: z.uuid(),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const threadPayloadSchema = z
  .object({
    version: z.literal(1),
    threadId: z.uuid(),
    sessionId: z.uuid(),
    resourceId: z.uuid(),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

type SessionPayload = z.infer<typeof sessionPayloadSchema>;
type ThreadPayload = z.infer<typeof threadPayloadSchema>;

export type PermissionAction =
  | "chat:read"
  | "chat:write"
  | "memory:read"
  | "memory:write"
  | "dataset:read"
  | "dataset:write"
  | "run:read"
  | "run:execute"
  | "artifact:read";

const permissionActionSchema = z.enum([
  "chat:read",
  "chat:write",
  "memory:read",
  "memory:write",
  "dataset:read",
  "dataset:write",
  "run:read",
  "run:execute",
  "artifact:read",
]);

export type PermissionContext = {
  principal: {
    id: string;
    kind: "server-issued-anonymous";
  };
  tenant: {
    id: string;
  };
  resource: {
    id: string;
    kind: "workspace";
  };
  session: {
    id: string;
    issuedAt: string;
    expiresAt: string;
  };
  thread: {
    id: string;
  };
  permittedActions: readonly PermissionAction[];
  datasetScope: {
    resourceId: string;
    allowedDatasetIds: readonly string[];
  };
  runScope: {
    resourceId: string;
    allowedRunIds: readonly string[];
  };
  risk: {
    level: "low";
    approvalRequired: false;
    approvalState: "not-required";
  };
};

export const permissionContextSchema = z
  .object({
    principal: z
      .object({
        id: z.uuid(),
        kind: z.literal("server-issued-anonymous"),
      })
      .strict(),
    tenant: z.object({ id: z.uuid() }).strict(),
    resource: z
      .object({
        id: z.uuid(),
        kind: z.literal("workspace"),
      })
      .strict(),
    session: z
      .object({
        id: z.uuid(),
        issuedAt: z.string().min(1),
        expiresAt: z.string().min(1),
      })
      .strict(),
    thread: z.object({ id: z.uuid() }).strict(),
    permittedActions: z.array(permissionActionSchema),
    datasetScope: z
      .object({
        resourceId: z.uuid(),
        allowedDatasetIds: z.array(z.string().min(1)),
      })
      .strict(),
    runScope: z
      .object({
        resourceId: z.uuid(),
        allowedRunIds: z.array(z.string().min(1)),
      })
      .strict(),
    risk: z
      .object({
        level: z.literal("low"),
        approvalRequired: z.literal(false),
        approvalState: z.literal("not-required"),
      })
      .strict(),
  })
  .strict();

export type ResolvedPermissionContext = {
  permissionContext: PermissionContext;
  sessionCookie?: string;
  threadCookie?: string;
  session: SessionPayload;
};

export class AuthorizationError extends Error {
  constructor() {
    super("Unauthorized session context.");
    this.name = "AuthorizationError";
  }
}

export class ConfigurationError extends Error {
  constructor() {
    super("Chat security is not configured on the server.");
    this.name = "ConfigurationError";
  }
}

function getSigningSecret(): string {
  const configuredSecret = process.env.SESSION_SIGNING_SECRET?.trim();
  if (configuredSecret) return configuredSecret;

  // Vitest does not load an application .env file. Keeping this fallback
  // limited to tests preserves fail-closed behavior in development and
  // production while allowing authorization tests to run in isolation.
  if (process.env.NODE_ENV === "test") return TEST_SIGNING_SECRET;

  throw new ConfigurationError();
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", getSigningSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function encodePayload(payload: SessionPayload | ThreadPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signedValue(payload: SessionPayload | ThreadPayload): string {
  const encodedPayload = encodePayload(payload);
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function verifySignature(encodedPayload: string, signature: string): boolean {
  const expected = Buffer.from(sign(encodedPayload), "utf8");
  const received = Buffer.from(signature, "utf8");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

function parseSignedValue(value: string): unknown {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) {
    throw new AuthorizationError();
  }

  const encodedPayload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!verifySignature(encodedPayload, signature)) {
    throw new AuthorizationError();
  }

  try {
    return JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
  } catch {
    throw new AuthorizationError();
  }
}

function assertNotExpired(expiresAt: number, now: number): void {
  if (expiresAt <= now) throw new AuthorizationError();
}

function getCookieValue(request: Request, cookieName: string): string | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;

    const name = cookie.slice(0, separator).trim();
    if (name !== cookieName) continue;

    const value = cookie.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      throw new AuthorizationError();
    }
  }

  return null;
}

function createSession(now = Date.now()): SessionPayload {
  const nowInSeconds = Math.floor(now / 1000);
  return {
    version: 1,
    sessionId: randomUUID(),
    principalId: randomUUID(),
    resourceId: randomUUID(),
    issuedAt: nowInSeconds,
    expiresAt: nowInSeconds + SESSION_TTL_SECONDS,
  };
}

function createThread(
  session: SessionPayload,
  now = Date.now(),
): ThreadPayload {
  const nowInSeconds = Math.floor(now / 1000);
  return {
    version: 1,
    threadId: randomUUID(),
    sessionId: session.sessionId,
    resourceId: session.resourceId,
    issuedAt: nowInSeconds,
    expiresAt: session.expiresAt,
  };
}

function parseSession(value: string, now: number): SessionPayload {
  const parsed = sessionPayloadSchema.safeParse(parseSignedValue(value));
  if (!parsed.success) throw new AuthorizationError();
  assertNotExpired(parsed.data.expiresAt, Math.floor(now / 1000));
  return parsed.data;
}

function parseThread(value: string, now: number): ThreadPayload {
  const parsed = threadPayloadSchema.safeParse(parseSignedValue(value));
  if (!parsed.success) throw new AuthorizationError();
  assertNotExpired(parsed.data.expiresAt, Math.floor(now / 1000));
  return parsed.data;
}

function createPermissionContext(
  session: SessionPayload,
  thread: ThreadPayload,
): PermissionContext {
  return {
    principal: {
      id: session.principalId,
      kind: "server-issued-anonymous",
    },
    tenant: {
      id: session.resourceId,
    },
    resource: {
      id: session.resourceId,
      kind: "workspace",
    },
    session: {
      id: session.sessionId,
      issuedAt: new Date(session.issuedAt * 1000).toISOString(),
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    },
    thread: {
      id: thread.threadId,
    },
    permittedActions: [
      "chat:read",
      "chat:write",
      "memory:read",
      "memory:write",
      "dataset:read",
      "run:read",
      "run:execute",
      "artifact:read",
    ],
    datasetScope: {
      resourceId: session.resourceId,
      allowedDatasetIds: [],
    },
    runScope: {
      resourceId: session.resourceId,
      allowedRunIds: [],
    },
    risk: {
      level: "low",
      approvalRequired: false,
      approvalState: "not-required",
    },
  };
}

export function resolvePermissionContext(
  request: Request,
  now = Date.now(),
): ResolvedPermissionContext {
  const sessionCookieValue = getCookieValue(request, SESSION_COOKIE);
  const threadCookieValue = getCookieValue(request, THREAD_COOKIE);

  if (!sessionCookieValue && threadCookieValue) {
    throw new AuthorizationError();
  }

  const session = sessionCookieValue
    ? parseSession(sessionCookieValue, now)
    : createSession(now);
  const thread = threadCookieValue
    ? parseThread(threadCookieValue, now)
    : createThread(session, now);

  if (
    thread.sessionId !== session.sessionId ||
    thread.resourceId !== session.resourceId
  ) {
    throw new AuthorizationError();
  }

  return {
    permissionContext: createPermissionContext(session, thread),
    sessionCookie: sessionCookieValue ? undefined : signedValue(session),
    threadCookie: threadCookieValue ? undefined : signedValue(thread),
    session,
  };
}

export function rotateThread(
  resolved: ResolvedPermissionContext,
  now = Date.now(),
): ResolvedPermissionContext {
  const thread = createThread(resolved.session, now);
  return {
    ...resolved,
    permissionContext: createPermissionContext(resolved.session, thread),
    threadCookie: signedValue(thread),
  };
}

export function createMastraRequestContext(
  permissionContext: PermissionContext,
): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_RESOURCE_ID_KEY, permissionContext.resource.id);
  requestContext.set(MASTRA_THREAD_ID_KEY, permissionContext.thread.id);
  requestContext.set("permissionContext", permissionContext);
  return requestContext;
}

export function getValidatedPermissionContext(
  requestContext: RequestContext | undefined,
): PermissionContext {
  if (!requestContext) throw new AuthorizationError();

  const parsed = permissionContextSchema.safeParse(
    requestContext.get("permissionContext"),
  );
  if (!parsed.success) throw new AuthorizationError();

  const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY);
  const threadId = requestContext.get(MASTRA_THREAD_ID_KEY);
  const issuedAt = Date.parse(parsed.data.session.issuedAt);
  const expiresAt = Date.parse(parsed.data.session.expiresAt);
  if (
    resourceId !== parsed.data.resource.id ||
    threadId !== parsed.data.thread.id ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > Date.now() ||
    expiresAt <= Date.now() ||
    parsed.data.tenant.id !== parsed.data.resource.id ||
    parsed.data.datasetScope.resourceId !== parsed.data.resource.id ||
    parsed.data.runScope.resourceId !== parsed.data.resource.id
  ) {
    throw new AuthorizationError();
  }

  return parsed.data as PermissionContext;
}

export function requirePermission(
  requestContext: RequestContext | undefined,
  action: PermissionAction,
): PermissionContext {
  const permissionContext = getValidatedPermissionContext(requestContext);
  if (!permissionContext.permittedActions.includes(action)) {
    throw new AuthorizationError();
  }
  return permissionContext;
}

export function assertResourceOwnership(
  permissionContext: PermissionContext,
  ownerResourceId: string,
): void {
  if (permissionContext.resource.id !== ownerResourceId) {
    throw new AuthorizationError();
  }
}

export function cookieHeader(
  name: string,
  value: string,
  request: Request,
): string {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export const sessionCookieName = SESSION_COOKIE;
export const threadCookieName = THREAD_COOKIE;
