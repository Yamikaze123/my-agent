import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getDataset,
  getDatasetContent,
  registerFinanceCsv,
} from "@/mastra/datasets/catalog";
import { profileFinanceDataset } from "@/mastra/profiling/finance-profile";
import {
  assessFinanceQuality,
  financeQualityRules,
} from "@/mastra/quality/finance-quality";
import { resolvePermissionContext } from "@/mastra/security/permission-context";

const defectiveDirectory = path.join(
  process.cwd(),
  "evaluation",
  "fixtures",
  "finance",
  "defective",
);

const knownRuleIds = financeQualityRules.map((rule) => rule.ruleId);

const manifestSchema = z
  .object({
    fixtureSetId: z.string().min(1),
    fixtures: z
      .array(
        z
          .object({
            file: z.string().regex(/^[a-z0-9-]+\.csv$/),
            expectedFindings: z
              .array(z.enum(knownRuleIds as [string, ...string[]]))
              .min(1),
          })
          .strict(),
      )
      .min(1),
    staleDefinition: z.string().min(1),
  })
  .strict();

const manifest = manifestSchema.parse(
  JSON.parse(
    readFileSync(path.join(defectiveDirectory, "manifest.json"), "utf8"),
  ),
);

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/datasets"))
    .permissionContext;
}

function assessFile(file: string) {
  const context = permissionContext();
  const bytes = new Uint8Array(
    readFileSync(path.join(defectiveDirectory, file)),
  );
  const entry = registerFinanceCsv(context, bytes);
  const currentEntry = getDataset(entry.dataset.datasetId, context);
  const content = getDatasetContent(entry.dataset.datasetId, context);
  const profile = profileFinanceDataset({ entry: currentEntry, ...content });
  return assessFinanceQuality({ entry: currentEntry, profile, ...content });
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe(`defective fixture set ${manifest.fixtureSetId}`, () => {
  it.each(manifest.fixtures.map((fixture) => [fixture.file, fixture] as const))(
    "%s produces its manifest findings with the gate outcome its rules declare",
    (_file, fixture) => {
      const report = assessFile(fixture.file);
      const ruleIds = report.findings.map((finding) => finding.ruleId);

      for (const expected of fixture.expectedFindings) {
        expect(ruleIds).toContain(expected);
      }

      // The gate outcome must follow the declared behavior of the expected
      // rules, so a fixture whose rules all warn cannot be blocked and a
      // fixture with any blocking rule cannot pass.
      const expectedRules = financeQualityRules.filter((rule) =>
        fixture.expectedFindings.includes(rule.ruleId),
      );
      const expectsBlock = expectedRules.some(
        (rule) => rule.gateBehavior === "block",
      );
      if (expectsBlock) {
        expect(report.status).toBe("block");
        expect(report.gateOutcome).toBe("blocked");
      } else {
        expect(report.status).toBe("warning");
        expect(report.gateOutcome).toBe("warning");
      }
    },
  );

  it("names every defective fixture file exactly once in the manifest", () => {
    const files = manifest.fixtures.map((fixture) => fixture.file);
    expect(new Set(files).size).toBe(files.length);
  });
});
