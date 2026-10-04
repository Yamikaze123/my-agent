import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import financeRegressionV2 from "../../../../evaluation/fixtures/finance/finance-regression-v2.json";
import financeRegressionV2Manifest from "../../../../evaluation/fixtures/finance/finance-regression-v2-manifest.json";
import { financeFixtureSchema } from "@/mastra/contracts/finance";
import { calculateMaximumDrawdown } from "@/mastra/metrics/finance-metrics";

describe("finance regression v2 fixture", () => {
  it("is a valid irregular, drawdown-bearing fixture with a verified hash", () => {
    const fixture = financeFixtureSchema.parse(financeRegressionV2);
    const canonicalRows = fixture.rows
      .map((row) => `${row.ticker}|${row.date}|${row.close}`)
      .join("\n");
    const contentHash = `sha256:${createHash("sha256")
      .update(canonicalRows)
      .digest("hex")}`;

    expect(fixture.version).toBe("v2");
    expect(fixture.rows).toHaveLength(financeRegressionV2Manifest.rowCount);
    expect(contentHash).toBe(financeRegressionV2Manifest.contentHash);
    expect(calculateMaximumDrawdown(fixture.rows.slice(0, 6))).toBeCloseTo(
      -35.71428571428571,
      10,
    );
    expect(fixture.rows[2].date).toBe("2025-03-31");
    expect(fixture.rows[3].date).toBe("2025-04-30");
  });
});
