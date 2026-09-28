import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CSV_FILE_BYTES } from "@/mastra/connectors/finance-csv";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...init?.headers,
        },
      }),
  },
}));

const { DELETE, GET, POST } = await import("@/app/api/datasets/route");

type RequestOptions = {
  cookie?: string;
  body?: BodyInit | null;
  contentType?: string;
};

function request(
  method: "GET" | "POST" | "DELETE",
  path = "/api/datasets",
  options: RequestOptions = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.contentType) headers.set("content-type", options.contentType);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

function cookies(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const read = (name: string) => {
    const value = setCookie.match(new RegExp(`${name}=([^;,]+)`))?.[1];
    if (!value) throw new Error(`Missing ${name} cookie.`);
    return value;
  };
  return `session_id=${read("session_id")}; thread_id=${read("thread_id")}`;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/datasets", () => {
  it("registers the fixture, returns owner-scoped catalog metadata, and deletes it", async () => {
    const established = await GET(request("GET"));
    const cookie = cookies(established);

    const registered = await POST(
      request("POST", "/api/datasets", {
        cookie,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ source: "fixture" }),
      }),
    );
    expect(registered.status).toBe(201);
    const registrationBody = await json(registered);
    const entry = registrationBody.dataset as {
      dataset: { datasetId: string; resourceId: string };
      source: { type: string; fixtureId: string };
    };
    expect(entry.source).toMatchObject({
      type: "fixture",
      fixtureId: "finance-regression",
    });

    const listed = await GET(request("GET", "/api/datasets", { cookie }));
    expect(await json(listed)).toMatchObject({
      datasets: [
        {
          dataset: {
            datasetId: entry.dataset.datasetId,
            resourceId: entry.dataset.resourceId,
          },
        },
      ],
      retentionHours: 24,
    });

    const retrieved = await GET(
      request("GET", `/api/datasets?datasetId=${entry.dataset.datasetId}`, {
        cookie,
      }),
    );
    expect(retrieved.status).toBe(200);
    expect(await json(retrieved)).toMatchObject({ dataset: entry });

    const deleted = await DELETE(
      request("DELETE", `/api/datasets?datasetId=${entry.dataset.datasetId}`, {
        cookie,
      }),
    );
    expect(deleted.status).toBe(200);
    expect(await json(deleted)).toEqual({ deleted: true });

    const afterDelete = await GET(
      request("GET", `/api/datasets?datasetId=${entry.dataset.datasetId}`, {
        cookie,
      }),
    );
    expect(afterDelete.status).toBe(404);
  });

  it("accepts a bounded raw CSV upload and rejects cross-resource lookup/deletion", async () => {
    const established = await GET(request("GET"));
    const ownerCookie = cookies(established);
    const uploaded = await POST(
      request("POST", "/api/datasets", {
        cookie: ownerCookie,
        contentType: "text/csv; charset=utf-8",
        body: "ticker,date,close\nAAPL,2025-01-31,102\n",
      }),
    );
    expect(uploaded.status).toBe(201);
    const body = await json(uploaded);
    const dataset = body.dataset as { dataset: { datasetId: string } };
    const datasetId = dataset.dataset.datasetId;

    const crossResourceRead = await GET(
      request("GET", `/api/datasets?datasetId=${datasetId}`),
    );
    expect(crossResourceRead.status).toBe(404);
    expect(await json(crossResourceRead)).toEqual({
      error: "Dataset not found.",
    });

    const crossResourceDelete = await DELETE(
      request("DELETE", `/api/datasets?datasetId=${datasetId}`),
    );
    expect(crossResourceDelete.status).toBe(404);

    const ownerRead = await GET(
      request("GET", `/api/datasets?datasetId=${datasetId}`, {
        cookie: ownerCookie,
      }),
    );
    expect(ownerRead.status).toBe(200);
  });

  it("rejects client-supplied ownership fields and unsupported media types", async () => {
    const established = await GET(request("GET"));
    const cookie = cookies(established);
    const forgedOwner = await POST(
      request("POST", "/api/datasets", {
        cookie,
        contentType: "application/json",
        body: JSON.stringify({ source: "fixture", resourceId: "attacker" }),
      }),
    );
    expect(forgedOwner.status).toBe(400);

    const unsupported = await POST(
      request("POST", "/api/datasets", {
        cookie,
        contentType: "text/plain",
        body: "ticker,date,close",
      }),
    );
    expect(unsupported.status).toBe(415);
  });

  it("counts streamed bytes and rejects oversized uploads before registration", async () => {
    const established = await GET(request("GET"));
    const cookie = cookies(established);
    const oversized = await POST(
      request("POST", "/api/datasets", {
        cookie,
        contentType: "text/csv",
        body: `x${"a".repeat(MAX_CSV_FILE_BYTES)}`,
      }),
    );

    expect(oversized.status).toBe(413);
    const listed = await GET(request("GET", "/api/datasets", { cookie }));
    expect(await json(listed)).toMatchObject({ datasets: [] });
  });
});
