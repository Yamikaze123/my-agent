import { createTool } from "@mastra/core/tools";
import {
  financeFixtureQuerySchema,
  financeFixtureResultSchema,
} from "../contracts/finance";
import { getFinanceFixture } from "../connectors/finance-fixture";

export const getFinanceFixtureTool = createTool({
  id: "get-finance-fixture",
  description:
    "Read the versioned synthetic finance fixture for evaluation, offline, and explicitly reproducible analysis. " +
    "This read-only connector does not contact a live market-data service; use yfinance for ordinary user market-data requests. " +
    "Returns provenance with every result.",
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
  execute: async (input) => getFinanceFixture(input),
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
