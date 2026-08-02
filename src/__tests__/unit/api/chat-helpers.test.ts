import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/mastra", () => ({
  mastra: {
    getAgentById: vi.fn().mockReturnValue({
      getMemory: vi.fn().mockReturnValue({
        recall: vi.fn().mockResolvedValue({ messages: [] }),
      }),
    }),
  },
}));

vi.mock("@mastra/ai-sdk", () => ({
  handleChatStream: vi.fn().mockResolvedValue(new ReadableStream()),
}));

vi.mock("@mastra/ai-sdk/ui", () => ({
  toAISdkV5Messages: vi.fn().mockReturnValue([]),
}));

vi.mock("ai", () => ({
  createUIMessageStreamResponse: vi.fn().mockReturnValue(
    new Response(null, { status: 200 }),
  ),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body) => new Response(JSON.stringify(body), { status: 200 })),
  },
}));

const { POST, GET } = await import("@/app/api/chat/route");

function makeRequest(
  method: "POST" | "GET",
  opts: { cookie?: string; body?: unknown } = {},
): Request {
  return new Request("http://localhost/api/chat", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("GET /api/chat", () => {
  it("returns 200", async () => {
    const req = makeRequest("GET");
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("sets a thread_id cookie in the response", async () => {
    const req = makeRequest("GET");
    const res = await GET(req);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/thread_id=/);
  });

  it("reuses an existing thread_id from the request cookie", async () => {
    const existingId = "my-existing-thread-id";
    const req = makeRequest("GET", { cookie: `thread_id=${existingId}` });
    const res = await GET(req);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(existingId);
  });

  it("generates a new thread_id when no cookie is present", async () => {
    const req1 = makeRequest("GET");
    const req2 = makeRequest("GET");
    const res1 = await GET(req1);
    const res2 = await GET(req2);

    const id1 = (res1.headers.get("Set-Cookie") ?? "").match(/thread_id=([^;]+)/)?.[1];
    const id2 = (res2.headers.get("Set-Cookie") ?? "").match(/thread_id=([^;]+)/)?.[1];
    // Both should be valid non-empty strings
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
  });
});

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a response", async () => {
    const req = makeRequest("POST", { body: { messages: [] } });
    const res = await POST(req);
    expect(res).toBeInstanceOf(Response);
  });

  it("sets a thread_id cookie in the response", async () => {
    const req = makeRequest("POST", { body: { messages: [] } });
    const res = await POST(req);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/thread_id=/);
  });

  it("reuses existing thread_id from cookie", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    const threadId = "test-thread-123";
    const req = makeRequest("POST", {
      body: { messages: [] },
      cookie: `thread_id=${threadId}`,
    });
    await POST(req);

    expect(handleChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          memory: expect.objectContaining({ thread: threadId }),
        }),
      }),
    );
  });

  it("passes resource ID to handleChatStream", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    const req = makeRequest("POST", { body: { messages: [] } });
    await POST(req);

    expect(handleChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "data-analysis-agent",
        params: expect.objectContaining({
          memory: expect.objectContaining({ resource: "data-analysis-chat" }),
        }),
      }),
    );
  });

  it("sets HttpOnly cookie with 1-year expiry", async () => {
    const req = makeRequest("POST", { body: { messages: [] } });
    const res = await POST(req);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=31536000");
  });
});

describe("thread ID cookie parsing", () => {
  it("handles multiple cookies and picks the right one", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    const req = makeRequest("POST", {
      body: { messages: [] },
      cookie: "other_cookie=abc; thread_id=correct-id; another=xyz",
    });
    await POST(req);

    expect(handleChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          memory: expect.objectContaining({ thread: "correct-id" }),
        }),
      }),
    );
  });
});
