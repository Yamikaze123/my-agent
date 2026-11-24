import { handleChatStream } from "@mastra/ai-sdk";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { MAX_AGENT_STEPS } from "@/mastra/config";
import {
  CHAT_LIMITS,
  CHAT_POLICY_VERSION,
  ChatGuardrailError,
  redactChatMessages,
  redactSensitiveText,
  selectLatestUserMessage,
  validateChatRequest,
} from "@/mastra/security/chat-policy";
import {
  AuthorizationError,
  ConfigurationError,
  clearCookieHeader,
  cookieHeader,
  createMastraRequestContext,
  requirePermission,
  resolvePermissionContext,
  rotateThread,
  sessionCookieName,
  threadCookieName,
} from "@/mastra/security/permission-context";
import {
  enforceRateLimit,
  rateLimitResponse,
} from "@/mastra/security/rate-limit";

// Comparison requests can require a complete data-fetching, validation,
// statistics, and plotting script. Keep enough room for the tool arguments so
// the stream does not end while a tool call is still being assembled.
const MAX_OUTPUT_TOKENS = 3_000;
const MAX_MODEL_RETRIES = 0;
// Server memory is the only source of conversation history for the model.
const MEMORY_HISTORY_MESSAGES = 12;
const MAX_HISTORY_OUTPUT_LENGTH = 8_000;

type JsonRecord = Record<string, unknown>;
type MastraInstance = (typeof import("@/mastra"))["mastra"];

async function loadMastra(): Promise<MastraInstance> {
  return (await import("@/mastra")).mastra;
}

const AUTHORIZATION_FIELDS = new Set([
  "agent",
  "agentId",
  "dataset",
  "datasetId",
  "permission",
  "permissions",
  "permissionContext",
  "principal",
  "principalId",
  "resource",
  "resourceId",
  "run",
  "runId",
  "tenant",
  "tenantId",
  "thread",
  "threadId",
  "user",
  "userId",
  "permittedActions",
  "datasetScope",
  "runScope",
  "approval",
  "approvalState",
  "risk",
  "ownerResourceId",
  "scope",
  "model",
  "modelId",
  "tools",
  "toolChoice",
  "maxSteps",
  "maxTokens",
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "system",
  "instructions",
  "providerOptions",
  "modelSettings",
  "requestContext",
  "memory",
  "headers",
]);

function truncateForModel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  return `${value.slice(0, maxLength)}\n[truncated before being sent to the model]`;
}

function compactToolOutput(output: unknown): unknown {
  if (typeof output === "string") {
    try {
      return JSON.stringify(compactToolOutput(JSON.parse(output)));
    } catch {
      return truncateForModel(output, MAX_HISTORY_OUTPUT_LENGTH);
    }
  }

  if (typeof output !== "object" || output === null) return output;

  const record = { ...(output as JsonRecord) };
  if (typeof record.stdout === "string") {
    record.stdout = truncateForModel(record.stdout, MAX_HISTORY_OUTPUT_LENGTH);
  }
  if (typeof record.stderr === "string") {
    record.stderr = truncateForModel(record.stderr, MAX_HISTORY_OUTPUT_LENGTH);
  }
  if (Array.isArray(record.images)) {
    record.imageCount = record.images.length;
    record.images = [];
  }

  return record;
}

function compactMessagePart(part: unknown): unknown {
  if (typeof part !== "object" || part === null) return part;

  const record = { ...(part as JsonRecord) };
  if ("output" in record) {
    record.output = compactToolOutput(record.output);
  }
  if ("result" in record) {
    record.result = compactToolOutput(record.result);
  }

  return record;
}

function compactMessages(messages: unknown): UIMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;

    const record = { ...(message as JsonRecord) };
    if (Array.isArray(record.parts)) {
      record.parts = record.parts.map(compactMessagePart);
    }
    if (Array.isArray(record.content)) {
      record.content = record.content.map(compactMessagePart);
    }

    return record;
  }) as UIMessage[];
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRateLimitError(error: unknown): boolean {
  return /rate[_ -]?limit|too[_ -]?many[_ -]?requests|rate_limit_exceeded|\b429\b/i.test(
    errorText(error),
  );
}

function formatStreamError(error: unknown): string {
  if (isRateLimitError(error)) {
    return "The analysis reached the model provider's token rate limit after the tool step. The provider should reset the limit shortly; please retry the summary in about a minute. The Python execution itself was not the rate-limited operation.";
  }

  console.error("Chat stream failed", redactSensitiveText(errorText(error)));
  return "The analysis could not be completed. Please try again.";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeClientAuthorizationFields(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !AUTHORIZATION_FIELDS.has(key)),
  );
}

function guardrailResponse(error: ChatGuardrailError): Response {
  return NextResponse.json(
    {
      error: error.userMessage,
      code: error.code,
      policyVersion: CHAT_POLICY_VERSION,
    },
    { status: error.status },
  );
}

function appendAuthCookies(
  response: Response,
  request: Request,
  resolved: ReturnType<typeof resolvePermissionContext>,
): Response {
  if (resolved.sessionCookie) {
    response.headers.append(
      "Set-Cookie",
      cookieHeader(sessionCookieName, resolved.sessionCookie, request),
    );
  }
  if (resolved.threadCookie) {
    response.headers.append(
      "Set-Cookie",
      cookieHeader(threadCookieName, resolved.threadCookie, request),
    );
  }
  return response;
}

function unauthorizedResponse(request: Request): Response {
  const response = NextResponse.json(
    { error: "Unauthorized session context." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
  response.headers.append(
    "Set-Cookie",
    clearCookieHeader(sessionCookieName, request),
  );
  response.headers.append(
    "Set-Cookie",
    clearCookieHeader(threadCookieName, request),
  );
  return response;
}

function configurationResponse(): Response {
  return NextResponse.json(
    {
      error:
        "Chat security is not configured on the server. Set SESSION_SIGNING_SECRET and restart the application.",
    },
    { status: 503 },
  );
}

function requestTooLarge(): ChatGuardrailError {
  return new ChatGuardrailError(
    "message_too_large",
    "That chat request is too large. Reload the page and try again.",
    413,
  );
}

/**
 * Read the JSON body without buffering more than the request limit. A missing
 * or understated Content-Length cannot bypass the cap because the stream is
 * counted as it is read.
 */
async function readBoundedJson(request: Request): Promise<unknown> {
  const maxBytes = CHAT_LIMITS.maxRequestBytes;
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    throw requestTooLarge();
  }

  if (!request.body) return JSON.parse("");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw requestTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Confirm that a stored thread, if one exists, belongs to the caller.
 * Returns whether the thread exists: a signed thread ID is issued before the
 * first message is saved, so "not stored yet" is a normal state.
 */
async function assertStoredThreadOwnership(
  mastra: MastraInstance,
  threadId: string,
  resourceId: string,
): Promise<boolean> {
  const memory = await mastra.getAgentById("data-analysis-agent").getMemory();
  if (!memory?.getThreadById) throw new AuthorizationError();

  const thread = await memory.getThreadById({ threadId });
  if (thread && thread.resourceId !== resourceId) {
    throw new AuthorizationError();
  }
  return Boolean(thread);
}

export async function POST(req: Request) {
  let resolved: ReturnType<typeof resolvePermissionContext>;
  try {
    resolved = resolvePermissionContext(req);
    requirePermission(
      createMastraRequestContext(resolved.permissionContext),
      "chat:write",
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError) return unauthorizedResponse(req);
    throw error;
  }

  const limit = enforceRateLimit(req, resolved, "chat:send");
  if (!limit.allowed) return rateLimitResponse(limit);

  // Validate the request before loading Mastra or touching storage, so a
  // malformed or oversized body costs nothing beyond reading it.
  let params: JsonRecord;
  try {
    const body = await readBoundedJson(req);
    const validated = validateChatRequest(
      selectLatestUserMessage(removeClientAuthorizationFields(body)),
    );
    // Only the newest validated user message is passed onward. History comes
    // from server memory; AI SDK control, provider, scope, and arbitrary
    // metadata fields remain server-owned.
    params = { messages: validated.messages };
  } catch (error) {
    if (error instanceof ChatGuardrailError) return guardrailResponse(error);
    return guardrailResponse(
      new ChatGuardrailError(
        "invalid_request",
        "The chat request body is invalid.",
        400,
      ),
    );
  }

  const mastra = await loadMastra();
  try {
    await assertStoredThreadOwnership(
      mastra,
      resolved.permissionContext.thread.id,
      resolved.permissionContext.resource.id,
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError) return unauthorizedResponse(req);
    throw error;
  }

  const stream = await handleChatStream({
    mastra,
    agentId: "data-analysis-agent",
    version: "v6",
    params: {
      ...params,
      messages: compactMessages(params.messages),
      maxSteps: MAX_AGENT_STEPS,
      requestContext: createMastraRequestContext(resolved.permissionContext),
      // maxOutputTokens is the provider-neutral cap; the OpenRouter provider
      // maps it to max_tokens. Provider-specific options under another
      // provider's key are ignored and so cannot enforce a limit here.
      modelSettings: {
        maxRetries: MAX_MODEL_RETRIES,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
      memory: {
        thread: resolved.permissionContext.thread.id,
        resource: resolved.permissionContext.resource.id,
        options: {
          lastMessages: MEMORY_HISTORY_MESSAGES,
        },
      },
    },
    onError: formatStreamError,
  });
  const response = createUIMessageStreamResponse({
    stream: stream as Parameters<
      typeof createUIMessageStreamResponse
    >[0]["stream"],
  });
  return appendAuthCookies(response, req, resolved);
}

export async function GET(req: Request) {
  let resolved: ReturnType<typeof resolvePermissionContext>;
  try {
    resolved = resolvePermissionContext(req);
    requirePermission(
      createMastraRequestContext(resolved.permissionContext),
      "memory:read",
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError) return unauthorizedResponse(req);
    throw error;
  }

  const limit = enforceRateLimit(req, resolved, "chat:read");
  if (!limit.allowed) return rateLimitResponse(limit);

  const mastra = await loadMastra();
  let threadExists: boolean;
  try {
    threadExists = await assertStoredThreadOwnership(
      mastra,
      resolved.permissionContext.thread.id,
      resolved.permissionContext.resource.id,
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError) return unauthorizedResponse(req);
    throw error;
  }

  const memory = await mastra.getAgentById("data-analysis-agent").getMemory();
  let response = null;

  try {
    // Recall rejects a thread that has not been stored yet, so a new
    // conversation is answered with an empty history without calling it.
    response = threadExists
      ? await memory?.recall({
          threadId: resolved.permissionContext.thread.id,
          resourceId: resolved.permissionContext.resource.id,
        })
      : null;
  } catch (error) {
    // The thread exists and is owned by the caller, so a failure here is a
    // storage problem. Report it instead of presenting an empty
    // conversation, which would look to the user like lost history.
    console.error(
      "Chat history could not be loaded",
      redactSensitiveText(errorText(error)),
    );
    return appendAuthCookies(
      NextResponse.json(
        {
          error:
            "The conversation history could not be loaded. Please try again.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
      req,
      resolved,
    );
  }

  const uiMessages = toAISdkMessages(response?.messages || [], {
    version: "v6",
  });

  const res = NextResponse.json(redactChatMessages(uiMessages as unknown[]));
  return appendAuthCookies(res, req, resolved);
}

export async function DELETE(request: Request) {
  let resolved: ReturnType<typeof resolvePermissionContext>;
  try {
    resolved = rotateThread(resolvePermissionContext(request));
    requirePermission(
      createMastraRequestContext(resolved.permissionContext),
      "chat:write",
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError)
      return unauthorizedResponse(request);
    throw error;
  }

  const limit = enforceRateLimit(request, resolved, "chat:read");
  if (!limit.allowed) return rateLimitResponse(limit);

  const response = NextResponse.json({ success: true });
  return appendAuthCookies(response, request, resolved);
}
