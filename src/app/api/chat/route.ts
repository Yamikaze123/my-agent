import { handleChatStream } from "@mastra/ai-sdk";
import { toAISdkV5Messages } from "@mastra/ai-sdk/ui";
import { createUIMessageStreamResponse } from "ai";
import { mastra } from "@/mastra";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

const RESOURCE_ID = "data-analysis-chat";
const THREAD_COOKIE = "thread_id";

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

  const stream = await handleChatStream({
    mastra,
    agentId: "data-analysis-agent",
    params: {
      ...params,
      memory: {
        ...params.memory,
        thread: threadId,
        resource: RESOURCE_ID,
      },
    },
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

  const uiMessages = toAISdkV5Messages(response?.messages || []);

  const res = NextResponse.json(uiMessages);
  return setThreadCookie(res, threadId);
}
