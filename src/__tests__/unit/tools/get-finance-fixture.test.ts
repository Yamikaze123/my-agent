import { describe, expect, it } from "vitest";
import { getFinanceFixtureTool } from "@/mastra/tools/get-finance-fixture";
import {
  createMastraRequestContext,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";

function authorizedContext() {
  const permissionContext = resolvePermissionContext(
    new Request("http://localhost/api/chat"),
  ).permissionContext;
  return {
    requestContext: createMastraRequestContext(permissionContext),
    resourceId: permissionContext.resource.id,
  };
}

describe("getFinanceFixtureTool", () => {
  it("exposes a typed read-only fixture tool", () => {
    expect(getFinanceFixtureTool.id).toBe("get-finance-fixture");
    expect(getFinanceFixtureTool.description).toContain(
      "does not contact a live market-data service",
    );
    expect(getFinanceFixtureTool.description).toContain("evaluation");
    expect(getFinanceFixtureTool.description).toContain(
      "call this tool with an empty input object ({})",
    );
    expect(getFinanceFixtureTool.description).toContain(
      "Never invent ticker symbols or date ranges",
    );
  });

  it("returns fixture rows and provenance to the application", async () => {
    const context = authorizedContext();
    const result = (await getFinanceFixtureTool.execute!(
      {
        tickers: ["MSFT"],
        startDate: "2025-01-01",
        endDate: "2025-02-28",
      },
      context,
    )) as Awaited<
      ReturnType<
        typeof import("@/mastra/connectors/finance-fixture").getFinanceFixture
      >
    >;

    expect(result.rows).toHaveLength(2);
    expect(result.provenance.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.provenance.dataset.contentHash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(result.dataset.resourceId).toBe(context.resourceId);
  });

  it("fails closed without a validated RequestContext", async () => {
    await expect(
      getFinanceFixtureTool.execute!({ tickers: ["MSFT"] }, {}),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("keeps the model-facing output structured and free of live-data claims", async () => {
    const result = (await getFinanceFixtureTool.execute!(
      {
        tickers: ["AAPL"],
      },
      authorizedContext(),
    )) as Awaited<
      ReturnType<
        typeof import("@/mastra/connectors/finance-fixture").getFinanceFixture
      >
    >;
    const modelOutput = getFinanceFixtureTool.toModelOutput?.(result) as {
      type: string;
      value: { provenance: typeof result.provenance; rows: unknown[] };
    };

    expect(modelOutput.type).toBe("json");
    expect(modelOutput.value.provenance.source.type).toBe("fixture");
    expect(modelOutput.value.rows).toHaveLength(13);
  });
});
