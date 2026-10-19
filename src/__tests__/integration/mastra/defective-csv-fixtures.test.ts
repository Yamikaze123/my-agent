import { readFileSync } from "node:fs";
import path from "node:path";
import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { registerFinanceCsv } from "@/mastra/datasets/catalog";
import { resolvePermissionContext } from "@/mastra/security/permission-context";
import { financeQualityRules } from "@/mastra/quality/finance-quality";
import {
  financeAnalysisWorkflow,
  runFinanceAnalysisWorkflow,
} from "@/mastra/workflows/finance-analysis";

const defectiveDirectory = path.join(
  process.cwd(),
  "evaluation",
  "fixtures",
  "finance",
  "defective",
);

const manifestSchema = z.object({
  fixtureSetId: z.string().min(1),
  fixtures: z
    .array(
      z.object({
        file: z.string().regex(/^[a-z0-9-]+\.csv$/),
        expectedFindings: z
          .array(
            z.enum(
              financeQualityRules.map((rule) => rule.ruleId) as [
                string,
                ...string[],
              ],
            ),
          )
          .min(1),
      }),
    )
    .min(1),
});

const manifest = manifestSchema.parse(
  JSON.parse(
    readFileSync(path.join(defectiveDirectory, "manifest.json"), "utf8"),
  ),
);

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/datasets"))
    .permissionContext;
}

beforeAll(() => {
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe(`defective fixture workflow set ${manifest.fixtureSetId}`, () => {
  it.each(manifest.fixtures.map((fixture) => [fixture.file, fixture] as const))(
    "%s reaches the workflow quality gate before metric calculation",
    async (file, fixture) => {
      const context = permissionContext();
      const entry = registerFinanceCsv(
        context,
        new Uint8Array(readFileSync(path.join(defectiveDirectory, file))),
      );
      const result = await runFinanceAnalysisWorkflow(context, {
        datasetId: entry.dataset.datasetId,
        metricId: "total-return",
      });
      const expectedRules = financeQualityRules.filter((rule) =>
        fixture.expectedFindings.includes(rule.ruleId),
      );
      const expectsBlock = expectedRules.some(
        (rule) => rule.gateBehavior === "block",
      );

      expect(result.status).toBe("completed");
      expect(
        result.qualityReport?.findings.map((finding) => finding.ruleId),
      ).toEqual(expect.arrayContaining(fixture.expectedFindings));

      if (expectsBlock) {
        expect(result.qualityReport).toMatchObject({
          status: "block",
          gateOutcome: "blocked",
        });
        expect(result.metrics).toEqual([]);
      } else {
        expect(result.qualityReport).toMatchObject({
          status: "warning",
          gateOutcome: "warning",
        });
        expect(result.metrics.length).toBeGreaterThan(0);
        expect(
          result.metrics.every((metric) => metric.qualityStatus === "warning"),
        ).toBe(true);
        expect(
          result.metrics.every(
            (metric) => metric.validationStatus === "warning",
          ),
        ).toBe(true);
      }
    },
  );
});
