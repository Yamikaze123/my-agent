import { handleChatStream } from "@mastra/ai-sdk";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { mastra } from "@/mastra";
import { NextResponse } from "next/server";
import { MAX_AGENT_STEPS } from "@/mastra/config";
import {
  AuthorizationError,
  ConfigurationError,
  cookieHeader,
  createMastraRequestContext,
  resolvePermissionContext,
  rotateThread,
  sessionCookieName,
  threadCookieName,
} from "@/mastra/security/permission-context";

// Comparison requests can require a complete data-fetching, validation,
// statistics, and plotting script. Keep enough room for the tool arguments so
// the stream does not end while a tool call is still being assembled.
const MAX_COMPLETION_TOKENS = 3_000;
const MAX_MODEL_RETRIES = 0;
const MAX_HISTORY_OUTPUT_LENGTH = 8_000;

type JsonRecord = Record<string, unknown>;

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

  console.error("Chat stream failed", errorText(error));
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

function unauthorizedResponse(): Response {
  return NextResponse.json(
    { error: "Unauthorized session context." },
    { status: 401 },
  );
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

async function assertStoredThreadOwnership(
  threadId: string,
  resourceId: string,
): Promise<void> {
  const memory = await mastra.getAgentById("data-analysis-agent").getMemory();
  if (!memory?.getThreadById) return;

  const thread = await memory.getThreadById({ threadId });
  if (thread && thread.resourceId !== resourceId) {
    throw new AuthorizationError();
  }
}

export async function POST(req: Request) {
  let resolved: ReturnType<typeof resolvePermissionContext>;
  try {
    resolved = resolvePermissionContext(req);
    await assertStoredThreadOwnership(
      resolved.permissionContext.thread.id,
      resolved.permissionContext.resource.id,
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError) return unauthorizedResponse();
    throw error;
  }

  const params = removeClientAuthorizationFields(await req.json());
  const modelSettings = isRecord(params.modelSettings)
    ? { ...params.modelSettings }
    : {};
  const providerOptions = isRecord(params.providerOptions)
    ? { ...params.providerOptions }
    : {};

  // The Azure deployment is backed by a newer model even though its deployment
  // ID is "gpt-4o". Remove the generic setting because the OpenAI adapter maps
  // it to max_tokens, which that deployment rejects.
  delete modelSettings.maxOutputTokens;

  const stream = await handleChatStream({
    mastra,
    agentId: "data-analysis-agent",
    version: "v6",
    params: {
      ...params,
      messages: compactMessages(params.messages),
      maxSteps: MAX_AGENT_STEPS,
      requestContext: createMastraRequestContext(resolved.permissionContext),
      modelSettings: {
        ...modelSettings,
        maxRetries: MAX_MODEL_RETRIES,
      },
      providerOptions: {
        ...providerOptions,
        openai: {
          ...(isRecord(providerOptions.openai) ? providerOptions.openai : {}),
          maxCompletionTokens: MAX_COMPLETION_TOKENS,
        },
      },
      memory: {
        thread: resolved.permissionContext.thread.id,
        resource: resolved.permissionContext.resource.id,
        options: {
          lastMessages: 8,
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
    await assertStoredThreadOwnership(
      resolved.permissionContext.thread.id,
      resolved.permissionContext.resource.id,
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError) return unauthorizedResponse();
    throw error;
  }

  const memory = await mastra.getAgentById("data-analysis-agent").getMemory();
  let response = null;

  try {
    response = await memory?.recall({
      threadId: resolved.permissionContext.thread.id,
      resourceId: resolved.permissionContext.resource.id,
    });
  } catch {
    console.log("No previous messages found.");
  }

  const uiMessages = toAISdkMessages(response?.messages || [], {
    version: "v6",
  });

  const res = NextResponse.json(uiMessages);
  return appendAuthCookies(res, req, resolved);
}

export async function DELETE(req?: Request) {
  const request =
    req ?? new Request("http://localhost/api/chat", { method: "DELETE" });
  let resolved: ReturnType<typeof resolvePermissionContext>;
  try {
    resolved = rotateThread(resolvePermissionContext(request));
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationResponse();
    if (error instanceof AuthorizationError) return unauthorizedResponse();
    throw error;
  }

  const response = NextResponse.json({ success: true });
  return appendAuthCookies(response, request, resolved);
}
