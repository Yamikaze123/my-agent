import { beforeEach, describe, expect, it } from "vitest";
import {
  registerFinanceCsv,
  registerFinanceFixture,
} from "@/mastra/datasets/catalog";
import {
  createMastraRequestContext,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";
import { listFinanceDatasetsTool } from "@/mastra/tools/list-finance-datasets";

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/chat"))
    .permissionContext;
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("listFinanceDatasetsTool", () => {
  it("returns owner-scoped catalog metadata without dataset rows", async () => {
    const context = permissionContext();
    const fixture = registerFinanceFixture(context);
    registerFinanceCsv(
      context,
      new TextEncoder().encode("ticker,date,close\nMSFT,2025-01-31,100\n"),
    );

    const result = (await listFinanceDatasetsTool.execute!(
      {},
      { requestContext: createMastraRequestContext(context) },
    )) as { datasets: Array<Record<string, unknown>> };

    expect(result.datasets).toHaveLength(2);
    expect(result.datasets.map((entry) => entry.dataset)).toEqual(
      expect.arrayContaining([fixture.dataset]),
    );
    expect(JSON.stringify(result)).not.toContain('"rows"');
  });

  it("does not list another resource's datasets", async () => {
    const owner = permissionContext();
    const other = permissionContext();
    registerFinanceFixture(owner);

    const result = (await listFinanceDatasetsTool.execute!(
      {},
      { requestContext: createMastraRequestContext(other) },
    )) as { datasets: unknown[] };

    expect(result.datasets).toEqual([]);
  });

  it("requires server request context", async () => {
    await expect(listFinanceDatasetsTool.execute!({}, {})).rejects.toThrow(
      /Unauthorized/,
    );
  });
});
