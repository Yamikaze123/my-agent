import {
  financeFixture,
  financeFixtureManifest,
  financeFixtureV2,
  financeFixtureV2Manifest,
  hashFinanceRows,
} from "../connectors/finance-fixture";
import {
  contentHashSchema,
  datasetRefSchema,
  financeFixtureManifestSchema,
  financePriceRowSchema,
  financeFixtureSchema,
  type DatasetRef,
  type FinanceFixture,
  type FinanceFixtureManifest,
  type FinancePriceRow,
} from "../contracts/finance";
import { z } from "zod";

const baselineFixturePayloadSchema = z
  .object({
    fixtureId: z.string().min(1),
    version: z.string().min(1),
    contentHash: contentHashSchema,
    rows: z.array(financePriceRowSchema).min(1),
  })
  .strict();

type ParsedBaselineFixturePayload = z.infer<
  typeof baselineFixturePayloadSchema
>;

export type BaselineFixturePayload = Omit<
  ParsedBaselineFixturePayload,
  "rows"
> & {
  rows: readonly Readonly<FinancePriceRow>[];
};

const fixtures = new Map<
  string,
  { fixture: typeof financeFixture; manifest: FinanceFixtureManifest }
>([
  ["v1", { fixture: financeFixture, manifest: financeFixtureManifest }],
  ["v2", { fixture: financeFixtureV2, manifest: financeFixtureV2Manifest }],
]);

function verifyFixture(
  fixture: typeof financeFixture,
  manifest: FinanceFixtureManifest,
): ParsedBaselineFixturePayload {
  financeFixtureSchema.parse(fixture);
  financeFixtureManifestSchema.parse(manifest);
  const contentHash = hashFinanceRows(fixture.rows);
  if (
    contentHash !== manifest.contentHash ||
    manifest.fixtureId !== fixture.fixtureId ||
    manifest.version !== fixture.version ||
    manifest.rowCount !== fixture.rows.length
  ) {
    throw new Error(
      `Evaluation fixture ${fixture.fixtureId}@${fixture.version} does not match its manifest.`,
    );
  }

  return baselineFixturePayloadSchema.parse({
    fixtureId: fixture.fixtureId,
    version: fixture.version,
    contentHash,
    rows: fixture.rows,
  });
}

/**
 * Supplies the same versioned, read-only rows to the historical baseline
 * adapter and the candidate harness. It deliberately does not register a
 * catalog dataset, run a quality rule, or calculate a governed metric.
 */
export function readOnlyFinanceFixtureAdapter(
  version: "v1" | "v2",
): BaselineFixturePayload {
  const selected = fixtures.get(version);
  if (!selected)
    throw new Error(`Unsupported evaluation fixture version ${version}.`);
  const payload = verifyFixture(selected.fixture, selected.manifest);
  return Object.freeze({
    ...payload,
    rows: Object.freeze(payload.rows.map((row) => Object.freeze({ ...row }))),
  });
}

export function baselineDatasetRef(
  payload: BaselineFixturePayload,
  resourceId: string,
): DatasetRef {
  return datasetRefSchema.parse({
    datasetId: payload.fixtureId,
    version: payload.version,
    contentHash: payload.contentHash,
    resourceId,
  });
}

export function fixtureManifestForVersion(
  version: "v1" | "v2",
): FinanceFixtureManifest {
  const selected = fixtures.get(version);
  if (!selected)
    throw new Error(`Unsupported evaluation fixture version ${version}.`);
  return selected.manifest;
}

export function financeFixtureForVersion(version: "v1" | "v2"): FinanceFixture {
  const selected = fixtures.get(version);
  if (!selected)
    throw new Error(`Unsupported evaluation fixture version ${version}.`);
  return selected.fixture;
}

export function fixtureRowsForVersion(
  version: "v1" | "v2",
): readonly FinancePriceRow[] {
  return readOnlyFinanceFixtureAdapter(version).rows;
}
