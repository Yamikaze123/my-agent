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
  toAISdkMessages: vi.fn().mockReturnValue([]),
}));

vi.mock("ai", () => ({
  createUIMessageStreamResponse: vi
    .fn()
    .mockReturnValue(new Response(null, { status: 200 })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
    ),
  },
}));

const { POST, GET, DELETE } = await import("@/app/api/chat/route");

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

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const value = header.match(new RegExp(`${name}=([^;]+)`))?.[1];
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value;
}

async function establishCookies(): Promise<string> {
  const response = await GET(makeRequest("GET"));
  return `session_id=${cookieValue(response, "session_id")}; thread_id=${cookieValue(response, "thread_id")}`;
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

  it("reuses an existing signed thread from the request cookies", async () => {
    const cookies = await establishCookies();
    const req = makeRequest("GET", { cookie: cookies });
    const res = await GET(req);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toBe("");
  });

  it("generates a new thread_id when no cookie is present", async () => {
    const req1 = makeRequest("GET");
    const req2 = makeRequest("GET");
    const res1 = await GET(req1);
    const res2 = await GET(req2);

    const id1 = (res1.headers.get("Set-Cookie") ?? "").match(
      /thread_id=([^;]+)/,
    )?.[1];
    const id2 = (res2.headers.get("Set-Cookie") ?? "").match(
      /thread_id=([^;]+)/,
    )?.[1];
    // Both should be valid non-empty strings
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
  });
});

describe("DELETE /api/chat", () => {
  it("starts a fresh thread by setting a new thread_id cookie", async () => {
    const res = await DELETE();
    const cookie = res.headers.get("Set-Cookie") ?? "";

    expect(res.status).toBe(200);
    expect(cookie).toMatch(/thread_id=.+/);
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

  it("reuses existing signed thread from cookie", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    const cookies = await establishCookies();
    const req = makeRequest("POST", {
      body: { messages: [] },
      cookie: cookies,
    });
    await POST(req);

    expect(handleChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          memory: expect.objectContaining({
            thread: expect.any(String),
            resource: expect.any(String),
          }),
        }),
      }),
    );
  });

  it("passes a server-controlled resource ID to handleChatStream", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    const req = makeRequest("POST", { body: { messages: [] } });
    await POST(req);

    const call = (handleChatStream as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.agentId).toBe("data-analysis-agent");
    expect(call.params.memory.resource).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(call.params.requestContext.toJSON()).toMatchObject({
      mastra__resourceId: call.params.memory.resource,
      mastra__threadId: call.params.memory.thread,
    });
  });

  it("ignores client-supplied authorization and routing fields", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    vi.clearAllMocks();
    const req = makeRequest("POST", {
      body: {
        messages: [],
        agentId: "attacker-agent",
        resourceId: "attacker-resource",
        tenantId: "attacker-tenant",
        threadId: "attacker-thread",
        datasetId: "attacker-dataset",
        runId: "attacker-run",
        permissionContext: { permittedActions: ["artifact:read"] },
        requestContext: { mastra__resourceId: "attacker-resource" },
      },
    });
    await POST(req);

    const call = (handleChatStream as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.agentId).toBe("data-analysis-agent");
    expect(call.params.resourceId).toBeUndefined();
    expect(call.params.threadId).toBeUndefined();
    expect(call.params.requestContext.toJSON().mastra__resourceId).not.toBe(
      "attacker-resource",
    );
  });

  it("sets HttpOnly signed cookies with a bounded expiry", async () => {
    const req = makeRequest("POST", { body: { messages: [] } });
    const res = await POST(req);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=2592000");
  });
});

describe("thread ID cookie parsing", () => {
  it("rejects a plain client-controlled thread cookie", async () => {
    const { handleChatStream } = await import("@mastra/ai-sdk");
    vi.clearAllMocks();
    const req = makeRequest("POST", {
      body: { messages: [] },
      cookie: "other_cookie=abc; thread_id=client-controlled-id; another=xyz",
    });
    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(handleChatStream).not.toHaveBeenCalled();
  });
});
