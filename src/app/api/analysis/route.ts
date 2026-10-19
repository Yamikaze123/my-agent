import { NextResponse } from "next/server";
import {
  analysisRunResultSchema,
  financeAnalysisInputSchema,
} from "@/mastra/contracts/finance";
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
import { runFinanceAnalysisWorkflow } from "@/mastra/workflows/finance-analysis";

export const runtime = "nodejs";

const MAX_JSON_REQUEST_BYTES = 2_048;
type Resolved = ReturnType<typeof resolvePermissionContext>;

class AnalysisRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AnalysisRequestError";
  }
}

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

function authorizeRequest(
  request: Request,
): { resolved: Resolved } | { response: Response } {
  try {
    const resolved = resolvePermissionContext(request);
    requirePermission(
      createMastraRequestContext(resolved.permissionContext),
      "run:execute",
    );
    return { resolved };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return {
        response: json(
          {
            error:
              "Analysis security is not configured. Set SESSION_SIGNING_SECRET on the server.",
          },
          503,
        ),
      };
    }
    if (error instanceof AuthorizationError) {
      return { response: unauthorizedResponse(request) };
    }
    throw error;
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new AnalysisRequestError(
      "Use application/json for an analysis request.",
      415,
    );
  }

  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new AnalysisRequestError(
      "Compressed request bodies are not supported.",
      415,
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new AnalysisRequestError("The request size is invalid.", 400);
    }
    if (Number(contentLength) > MAX_JSON_REQUEST_BYTES) {
      throw new AnalysisRequestError(
        `Analysis requests may not exceed ${MAX_JSON_REQUEST_BYTES} bytes.`,
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
      if (totalBytes > MAX_JSON_REQUEST_BYTES) {
        await reader.cancel();
        throw new AnalysisRequestError(
          `Analysis requests may not exceed ${MAX_JSON_REQUEST_BYTES} bytes.`,
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

function requestBodyError(error: unknown): Response {
  if (error instanceof AnalysisRequestError) {
    return json({ error: error.message }, error.status);
  }
  if (error instanceof SyntaxError) {
    return json({ error: "The analysis request is not valid JSON." }, 400);
  }
  return json({ error: "The analysis request could not be completed." }, 500);
}

export async function POST(request: Request): Promise<Response> {
  const authorization = authorizeRequest(request);
  if ("response" in authorization) return authorization.response;
  const { resolved } = authorization;

  try {
    const bodyBytes = await readBoundedBody(request);
    let decodedBody: string;
    try {
      decodedBody = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    } catch {
      throw new AnalysisRequestError(
        "The analysis request must use valid UTF-8 encoding.",
        400,
      );
    }

    const requestBody: unknown = JSON.parse(decodedBody);
    const parsedInput = financeAnalysisInputSchema.safeParse(requestBody);
    if (!parsedInput.success) {
      return appendAuthCookies(
        json(
          {
            error: "The analysis request is invalid.",
            issues: parsedInput.error.issues.map(({ code, path }) => ({
              code,
              path: path.join("."),
            })),
          },
          400,
        ),
        request,
        resolved,
      );
    }

    const result = analysisRunResultSchema.parse(
      await runFinanceAnalysisWorkflow(
        resolved.permissionContext,
        parsedInput.data,
      ),
    );
    return appendAuthCookies(json(result), request, resolved);
  } catch (error) {
    return appendAuthCookies(requestBodyError(error), request, resolved);
  }
}
