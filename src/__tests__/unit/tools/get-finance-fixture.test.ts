import { describe, expect, it } from "vitest";
import { getFinanceFixtureTool } from "@/mastra/tools/get-finance-fixture";

describe("getFinanceFixtureTool", () => {
  it("exposes a typed read-only fixture tool", () => {
    expect(getFinanceFixtureTool.id).toBe("get-finance-fixture");
    expect(getFinanceFixtureTool.description).toContain(
      "does not contact a live market-data service",
    );
    expect(getFinanceFixtureTool.description).toContain("evaluation");
  });

  it("returns fixture rows and provenance to the application", async () => {
    const result = await getFinanceFixtureTool.execute!(
      {
        tickers: ["MSFT"],
        startDate: "2025-01-01",
        endDate: "2025-02-28",
      },
      {},
    );

    expect(result.rows).toHaveLength(2);
    expect(result.provenance.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.provenance.dataset.contentHash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it("keeps the model-facing output structured and free of live-data claims", async () => {
    const result = await getFinanceFixtureTool.execute!(
      {
        tickers: ["AAPL"],
      },
      {},
    );
    const modelOutput = getFinanceFixtureTool.toModelOutput?.(result) as {
      type: string;
      value: { provenance: typeof result.provenance; rows: unknown[] };
    };

    expect(modelOutput.type).toBe("json");
    expect(modelOutput.value.provenance.source.type).toBe("fixture");
    expect(modelOutput.value.rows).toHaveLength(13);
  });
});
