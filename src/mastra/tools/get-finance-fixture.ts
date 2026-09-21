import { createTool } from "@mastra/core/tools";
import {
  financeFixtureQuerySchema,
  financeFixtureResultSchema,
} from "../contracts/finance";
import {
  financeFixtureAvailability,
  getFinanceFixture,
} from "../connectors/finance-fixture";
import { requirePermission } from "../security/permission-context";

export const getFinanceFixtureTool = createTool({
  id: "get-finance-fixture",
  description: `Read the versioned synthetic finance fixture for evaluation, offline, and explicitly reproducible analysis. This read-only connector does not contact a live market-data service; use yfinance for ordinary user market-data requests. The canonical fixture contains tickers ${financeFixtureAvailability.tickers.join(", ")} and rows from ${financeFixtureAvailability.startDate} through ${financeFixtureAvailability.endDate}. For a complete fixture profile, call this tool with an empty input object ({}), omitting tickers, startDate, and endDate. Never invent ticker symbols or date ranges. Only pass optional filters that the user explicitly requested and that are available in the canonical fixture. If a filter is rejected, do not repeat the same arguments. Returns provenance with every result.`,
  inputSchema: financeFixtureQuerySchema,
  outputSchema: financeFixtureResultSchema,
  mcp: {
    annotations: {
      title: "Get finance fixture",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  execute: async (input, context) => {
    requirePermission(context?.requestContext, "dataset:read");
    return getFinanceFixture(input);
  },
  toModelOutput: (output) => ({
    type: "json" as const,
    value: {
      dataset: output.dataset,
      source: output.source,
      provenance: output.provenance,
      rows: output.rows,
    },
  }),
});
