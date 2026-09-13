import { handleChatStream } from "@mastra/ai-sdk";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { createUIMessageStreamResponse } from "ai";
import { mastra } from "@/mastra";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { MAX_AGENT_STEPS } from "@/mastra/config";

const RESOURCE_ID = "data-analysis-chat";
const THREAD_COOKIE = "thread_id";
// Comparison requests can require a complete data-fetching, validation,
// statistics, and plotting script. Keep enough room for the tool arguments so
// the stream does not end while a tool call is still being assembled.
const MAX_COMPLETION_TOKENS = 3_000;
const MAX_MODEL_RETRIES = 0;
const MAX_HISTORY_OUTPUT_LENGTH = 8_000;

type JsonRecord = Record<string, unknown>;

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

function compactMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;

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
  });
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

function getThreadIdFromRequest(req: Request): string {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${THREAD_COOKIE}=`));
  return match?.split("=")[1] || randomUUID();
}

function setThreadCookie(response: Response, threadId: string): Response {
  response.headers.append(
    "Set-Cookie",
    `${THREAD_COOKIE}=${threadId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`,
  );
  return response;
}

export async function POST(req: Request) {
  const params = await req.json();
  const threadId = getThreadIdFromRequest(req);
  const modelSettings = { ...(params.modelSettings ?? {}) };

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
      modelSettings: {
        ...modelSettings,
        maxRetries: MAX_MODEL_RETRIES,
      },
      providerOptions: {
        ...params.providerOptions,
        openai: {
          ...params.providerOptions?.openai,
          maxCompletionTokens: MAX_COMPLETION_TOKENS,
        },
      },
      memory: {
        ...params.memory,
        thread: threadId,
        resource: RESOURCE_ID,
        options: {
          ...params.memory?.options,
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
  return setThreadCookie(response, threadId);
}

export async function GET(req: Request) {
  const threadId = getThreadIdFromRequest(req);
  const memory = await mastra.getAgentById("data-analysis-agent").getMemory();
  let response = null;

  try {
    response = await memory?.recall({
      threadId,
      resourceId: RESOURCE_ID,
    });
  } catch {
    console.log("No previous messages found.");
  }

  const uiMessages = toAISdkMessages(response?.messages || [], {
    version: "v6",
  });

  const res = NextResponse.json(uiMessages);
  return setThreadCookie(res, threadId);
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  return setThreadCookie(response, randomUUID());
}
