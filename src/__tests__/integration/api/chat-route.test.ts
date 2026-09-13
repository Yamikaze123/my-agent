import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecall = vi.fn().mockResolvedValue({ messages: [] });
const mockGetMemory = vi.fn().mockReturnValue({ recall: mockRecall });
const mockGetAgentById = vi.fn().mockReturnValue({ getMemory: mockGetMemory });

vi.mock("@/mastra", () => ({
  mastra: { getAgentById: mockGetAgentById },
}));

const mockStream = new ReadableStream({
  start(controller) {
    controller.enqueue(
      new TextEncoder().encode('data: {"role":"assistant","content":"hi"}\n\n'),
    );
    controller.close();
  },
});

vi.mock("@mastra/ai-sdk", () => ({
  handleChatStream: vi.fn().mockResolvedValue(mockStream),
}));

vi.mock("@mastra/ai-sdk/ui", () => ({
  toAISdkMessages: vi.fn((input) => input?.messages ?? []),
}));

vi.mock("ai", () => ({
  createUIMessageStreamResponse: vi.fn((opts) => {
    return new Response(opts.stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn(
      (body) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  },
}));

const { POST, GET, DELETE } = await import("@/app/api/chat/route");

function chatRequest(
  method: "POST" | "GET",
  opts: { cookie?: string; body?: unknown } = {},
) {
  return new Request("http://localhost/api/chat", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecall.mockResolvedValue({ messages: [] });
  mockGetMemory.mockReturnValue({ recall: mockRecall });
  mockGetAgentById.mockReturnValue({ getMemory: mockGetMemory });
});

describe("POST /api/chat — streaming response", () => {
  it("responds with 200 and streams content", async () => {
    const res = await POST(
      chatRequest("POST", {
        body: { messages: [{ role: "user", content: "hello" }] },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("calls handleChatStream with the correct agentId", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    await POST(chatRequest("POST", { body: { messages: [] } }));
    expect(handleChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "data-analysis-agent" }),
    );
  });

  it("forwards all user message params to the stream handler", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    const body = {
      messages: [{ role: "user", content: "analyze this" }],
      someExtra: "value",
    };
    await POST(chatRequest("POST", { body }));

    const callArg = (handleChatStream as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.params.messages).toEqual(body.messages);
  });

  it("bounds model steps, output, retries, and memory history", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    await POST(chatRequest("POST", { body: { messages: [] } }));

    const callArg = (handleChatStream as ReturnType<typeof vi.fn>).mock
      .calls[0][0];

    expect(callArg.params.maxSteps).toBe(5);
    expect(callArg.version).toBe("v6");
    expect(callArg.params.modelSettings).toEqual({
      maxRetries: 0,
    });
    expect(callArg.params.providerOptions).toEqual({
      openai: {
        maxCompletionTokens: 3000,
      },
    });
    expect(callArg.params.memory.options.lastMessages).toBe(8);
  });

  it("removes image payloads from historical tool messages sent to the model", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    await POST(
      chatRequest("POST", {
        body: {
          messages: [
            {
              role: "assistant",
              parts: [
                {
                  type: "tool-runPythonCodeTool",
                  output: {
                    stdout: "stats",
                    stderr: "",
                    images: ["large-base64-image"],
                    success: true,
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const callArg = (handleChatStream as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.params.messages[0].parts[0].output).toEqual({
      stdout: "stats",
      stderr: "",
      images: [],
      imageCount: 1,
      success: true,
    });
  });

  it("returns a retry-later message for provider rate limits", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    await POST(chatRequest("POST", { body: { messages: [] } }));

    const callArg = (handleChatStream as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const message = callArg.onError(
      new Error("rate_limit_exceeded: tokens exhausted"),
    );

    expect(message).toContain("token rate limit");
    expect(message).toContain("retry");
  });

  it("persists thread_id across requests via cookie", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    const threadId = "persistent-thread-abc";

    await POST(
      chatRequest("POST", {
        body: { messages: [] },
        cookie: `thread_id=${threadId}`,
      }),
    );

    const callArg = (handleChatStream as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.params.memory.thread).toBe(threadId);
  });

  it("sets thread_id cookie in the response", async () => {
    const res = await POST(chatRequest("POST", { body: { messages: [] } }));
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/thread_id=.+/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("GET /api/chat — message history", () => {
  it("returns 200 with prior messages", async () => {
    const res = await GET(chatRequest("GET"));
    expect(res.status).toBe(200);
  });

  it("calls memory.recall with the thread and resource IDs", async () => {
    const threadId = "recall-thread-xyz";
    await GET(chatRequest("GET", { cookie: `thread_id=${threadId}` }));

    expect(mockRecall).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        resourceId: "data-analysis-chat",
      }),
    );
  });

  it("returns an empty array when recall throws (no previous messages)", async () => {
    mockRecall.mockRejectedValueOnce(new Error("No thread found"));
    const res = await GET(chatRequest("GET"));
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("sets thread_id cookie in the response", async () => {
    const res = await GET(chatRequest("GET"));
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/thread_id=.+/);
  });

  it("gets the agent by the correct ID", async () => {
    await GET(chatRequest("GET"));
    expect(mockGetAgentById).toHaveBeenCalledWith("data-analysis-agent");
  });
});

describe("DELETE /api/chat — new chat", () => {
  it("rotates the thread_id cookie", async () => {
    const res = await DELETE();
    const cookie = res.headers.get("Set-Cookie") ?? "";

    expect(res.status).toBe(200);
    expect(cookie).toMatch(/thread_id=.+/);
    expect(cookie).toContain("Max-Age=31536000");
  });
});
