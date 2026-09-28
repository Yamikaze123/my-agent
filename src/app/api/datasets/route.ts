import { NextResponse } from "next/server";
import { z } from "zod";
import {
  acquireCsvUploadSlot,
  DATASET_RETENTION_HOURS,
  DatasetCatalogError,
  deleteDataset,
  getDataset,
  listDatasets,
  registerFinanceCsv,
  registerFinanceFixture,
} from "@/mastra/datasets/catalog";
import {
  FinanceCsvError,
  MAX_CSV_FILE_BYTES,
} from "@/mastra/connectors/finance-csv";
import type { DatasetCatalogEntry } from "@/mastra/contracts/finance";
import {
  AuthorizationError,
  ConfigurationError,
  clearCookieHeader,
  cookieHeader,
  createMastraRequestContext,
  requirePermission,
  resolvePermissionContext,
  sessionCookieName,
  threadCookieName,
} from "@/mastra/security/permission-context";

export const runtime = "nodejs";

const fixtureRegistrationSchema = z
  .object({ source: z.literal("fixture") })
  .strict();
const datasetIdSchema = z.uuid();
const MAX_JSON_REQUEST_BYTES = 1_024;

type Resolved = ReturnType<typeof resolvePermissionContext>;

function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function appendAuthCookies(
  response: Response,
  request: Request,
  resolved: Resolved,
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
  const response = json({ error: "Unauthorized session context." }, 401);
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
  return json(
    {
      error:
        "Dataset security is not configured. Set SESSION_SIGNING_SECRET on the server.",
    },
    503,
  );
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof DatasetCatalogError ||
    error instanceof FinanceCsvError
  ) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof SyntaxError) {
    return json({ error: "The request body is not valid JSON." }, 400);
  }
  return json({ error: "The dataset request could not be completed." }, 500);
}

function authorizeRequest(
  request: Request,
  action: "dataset:read" | "dataset:write",
): { resolved: Resolved } | { response: Response } {
  try {
    const resolved = resolvePermissionContext(request);
    requirePermission(
      createMastraRequestContext(resolved.permissionContext),
      action,
    );
    return { resolved };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { response: configurationResponse() };
    }
    if (error instanceof AuthorizationError) {
      return { response: unauthorizedResponse(request) };
    }
    throw error;
  }
}

function assertIdentityEncoding(request: Request): void {
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new DatasetCatalogError(
      "unsupported_media_type",
      "Compressed request bodies are not supported.",
      415,
    );
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  assertIdentityEncoding(request);
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new DatasetCatalogError(
        "invalid_registration",
        "The request Content-Length is invalid.",
        400,
      );
    }
    if (Number(contentLength) > maxBytes) {
      throw new DatasetCatalogError(
        "invalid_registration",
        `Request bodies may not exceed ${maxBytes} bytes.`,
        413,
      );
    }
  }

  if (!request.body) return new Uint8Array();
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
        throw new DatasetCatalogError(
          "invalid_registration",
          `Request bodies may not exceed ${maxBytes} bytes.`,
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function contentType(request: Request): string {
  return (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function assertUtf8ContentType(request: Request): void {
  const rawContentType = request.headers.get("content-type") ?? "";
  const parts = rawContentType.split(";").map((part) => part.trim());
  if (
    parts
      .slice(1)
      .some((parameter) => !/^charset\s*=\s*"?utf-8"?$/i.test(parameter))
  ) {
    throw new DatasetCatalogError(
      "unsupported_media_type",
      "Dataset requests must use UTF-8 encoding.",
      415,
    );
  }
}

function requestedDatasetId(request: Request): string | null {
  return new URL(request.url).searchParams.get("datasetId");
}

export async function GET(request: Request): Promise<Response> {
  const authorization = authorizeRequest(request, "dataset:read");
  if ("response" in authorization) return authorization.response;
  const { resolved } = authorization;

  try {
    const id = requestedDatasetId(request);
    if (id !== null && !datasetIdSchema.safeParse(id).success) {
      return appendAuthCookies(
        json({ error: "datasetId must be a valid dataset identifier." }, 400),
        request,
        resolved,
      );
    }

    const body = id
      ? { dataset: getDataset(id, resolved.permissionContext) }
      : {
          datasets: listDatasets(resolved.permissionContext),
          retentionHours: DATASET_RETENTION_HOURS,
        };
    return appendAuthCookies(json(body), request, resolved);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return appendAuthCookies(
        json({ error: "Dataset not found." }, 404),
        request,
        resolved,
      );
    }
    return appendAuthCookies(errorResponse(error), request, resolved);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = authorizeRequest(request, "dataset:write");
  if ("response" in authorization) return authorization.response;
  const { resolved } = authorization;

  try {
    const type = contentType(request);
    let dataset: DatasetCatalogEntry;
    if (type === "application/json") {
      assertUtf8ContentType(request);
      const bytes = await readBoundedBody(request, MAX_JSON_REQUEST_BYTES);
      let decodedBody: string;
      try {
        decodedBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new DatasetCatalogError(
          "invalid_registration",
          "The JSON request body must use valid UTF-8 encoding.",
          400,
        );
      }
      const body = JSON.parse(decodedBody);
      if (!fixtureRegistrationSchema.safeParse(body).success) {
        throw new DatasetCatalogError(
          "invalid_registration",
          'Fixture registration requires the JSON body {"source":"fixture"}.',
          400,
        );
      }
      dataset = registerFinanceFixture(resolved.permissionContext);
    } else if (type === "text/csv") {
      assertUtf8ContentType(request);
      const releaseUploadSlot = acquireCsvUploadSlot(
        resolved.permissionContext,
      );
      try {
        const bytes = await readBoundedBody(request, MAX_CSV_FILE_BYTES);
        dataset = registerFinanceCsv(resolved.permissionContext, bytes);
      } finally {
        releaseUploadSlot();
      }
    } else {
      throw new DatasetCatalogError(
        "unsupported_media_type",
        "Use application/json to register the finance fixture or text/csv for a CSV upload.",
        415,
      );
    }

    return appendAuthCookies(json({ dataset }, 201), request, resolved);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return appendAuthCookies(
        json({ error: "Dataset not found." }, 404),
        request,
        resolved,
      );
    }
    return appendAuthCookies(errorResponse(error), request, resolved);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const authorization = authorizeRequest(request, "dataset:write");
  if ("response" in authorization) return authorization.response;
  const { resolved } = authorization;

  const id = requestedDatasetId(request);
  if (id === null || !datasetIdSchema.safeParse(id).success) {
    return appendAuthCookies(
      json({ error: "A valid datasetId query parameter is required." }, 400),
      request,
      resolved,
    );
  }

  try {
    deleteDataset(id, resolved.permissionContext);
    return appendAuthCookies(json({ deleted: true }), request, resolved);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return appendAuthCookies(
        json({ error: "Dataset not found." }, 404),
        request,
        resolved,
      );
    }
    return appendAuthCookies(errorResponse(error), request, resolved);
  }
}
