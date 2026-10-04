import { createTool } from "@mastra/core/tools";
import {
  analysisRunResultSchema,
  financeAnalysisModelOutputSchema,
  financeMetricRequestSchema,
} from "../contracts/finance";
import { requirePermission } from "../security/permission-context";
import { runFinanceAnalysisWorkflow } from "../workflows/finance-analysis";

/**
 * The model supplies analysis intent and an opaque dataset ID. The workflow
 * resolves the dataset against the caller's server-issued RequestContext; no
 * resource, tenant, owner, or permission field is accepted here.
 */
export const runFinanceAnalysisTool = createTool({
  id: "run-finance-analysis",
  description:
    "Calculate one documented finance metric from a dataset already registered in the caller's own catalog. Provide a datasetId from the user's request or list-finance-datasets, a metricId of total-return, volatility, or maximum-drawdown, and optionally a ticker and inclusive startDate/endDate filters. Omitting ticker calculates the metric separately for every ticker in the selected dataset; the run is all-or-nothing if any selected ticker lacks enough observations. The server, not the model, verifies dataset ownership from the request context and returns the full quality gate, metric values, assumptions, and provenance to the application.",
  inputSchema: financeMetricRequestSchema,
  outputSchema: analysisRunResultSchema,
  mcp: {
    annotations: {
      title: "Run finance analysis",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  execute: async (input, context) => {
    const permissionContext = requirePermission(
      context?.requestContext,
      "run:execute",
    );
    return runFinanceAnalysisWorkflow(permissionContext, input);
  },
  toModelOutput: (output) => ({
    type: "json" as const,
    value: financeAnalysisModelOutputSchema.parse({
      status: output.status,
      runId: output.runId,
      ...(output.qualityReport
        ? {
            gateOutcome: output.qualityReport.gateOutcome,
            findings: output.qualityReport.findings,
          }
        : { findings: [] }),
      metrics: output.metrics.map(
        ({
          metricId,
          definitionVersion,
          value,
          unit,
          currency,
          dimensions,
          validationStatus,
          qualityStatus,
        }) => ({
          metricId,
          definitionVersion,
          value,
          unit,
          ...(currency ? { currency } : {}),
          dimensions,
          validationStatus,
          ...(qualityStatus ? { qualityStatus } : {}),
        }),
      ),
      assumptions: [
        ...new Set(output.metrics.flatMap((metric) => metric.assumptions)),
      ]
        .slice(0, 32)
        .map((assumption) => assumption.slice(0, 4_000)),
      ...(output.provenance
        ? {
            provenance: {
              runId: output.provenance.runId,
              dataset: output.provenance.dataset,
              source: {
                type: output.provenance.source.type,
                connector: output.provenance.source.connector,
                provider: output.provenance.source.provider,
                ...(output.provenance.source.fixtureId
                  ? { fixtureId: output.provenance.source.fixtureId }
                  : {}),
                ...(output.provenance.source.fixtureVersion
                  ? {
                      fixtureVersion: output.provenance.source.fixtureVersion,
                    }
                  : {}),
                ...(output.provenance.source.contentHash
                  ? { contentHash: output.provenance.source.contentHash }
                  : {}),
              },
            },
          }
        : {}),
      error: output.error,
    }),
  }),
});
