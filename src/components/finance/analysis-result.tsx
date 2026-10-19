import type {
  AnalysisRunResult,
  DataProfile,
  MetricResult,
  QualityFinding,
} from "@/mastra/contracts/finance";

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 6,
  }).format(value);
}

function shortHash(value: string): string {
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

function qualityLabel(status: string): string {
  if (status === "pass") return "Passed";
  if (status === "warning") return "Warnings";
  return "Blocked";
}

function metricLabel(metricId: string): string {
  const labels: Record<string, string> = {
    "total-return": "Total return",
    volatility: "Annualized volatility",
    "maximum-drawdown": "Maximum drawdown",
  };
  return labels[metricId] ?? metricId.replaceAll("-", " ");
}

function metricValue(metric: MetricResult): string {
  if (metric.value === undefined) return "Tabular result";
  const value = formatNumber(metric.value);
  if (metric.unit === "percent") return `${value}%`;
  if (metric.unit === "currency") {
    return metric.currency ? `${metric.currency} ${value}` : value;
  }
  return `${value} ${metric.unit}`;
}

function displayCell(value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "number") return formatNumber(value);
  return String(value);
}

function ProfileSummary({ profile }: { profile: DataProfile }) {
  const schemaFields = profile.schema.slice(0, 20);
  const numericSummaries = Object.entries(profile.numericSummary).slice(0, 12);

  return (
    <section className="space-y-3 border-t border-border/70 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Dataset profile</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Profile {profile.profileVersion} ·{" "}
            {profile.rowCount.toLocaleString()} rows ·{" "}
            {profile.columnCount.toLocaleString()} columns
          </p>
        </div>
        {profile.dateBounds && (
          <p className="text-xs text-muted-foreground">
            {profile.dateBounds.startDate} to {profile.dateBounds.endDate}
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/70">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Nulls</th>
              <th className="px-3 py-2 font-medium">Distinct</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {schemaFields.map((field) => (
              <tr key={field.name}>
                <td className="px-3 py-2 font-medium">{field.name}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {field.logicalType}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {field.semanticRole}
                </td>
                <td className="px-3 py-2">
                  {profile.nullCounts[field.name] ?? 0}
                </td>
                <td className="px-3 py-2">
                  {profile.uniqueCounts[field.name] ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {profile.schema.length > schemaFields.length && (
        <p className="text-xs text-muted-foreground">
          Showing the first {schemaFields.length} fields.
        </p>
      )}

      {numericSummaries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Numeric field</th>
                <th className="px-3 py-2 font-medium">Count</th>
                <th className="px-3 py-2 font-medium">Min</th>
                <th className="px-3 py-2 font-medium">Mean</th>
                <th className="px-3 py-2 font-medium">Max</th>
                <th className="px-3 py-2 font-medium">Std. dev.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {numericSummaries.map(([field, summary]) => (
                <tr key={field}>
                  <td className="px-3 py-2 font-medium">{field}</td>
                  <td className="px-3 py-2">{summary.count}</td>
                  <td className="px-3 py-2">{formatNumber(summary.min)}</td>
                  <td className="px-3 py-2">{formatNumber(summary.mean)}</td>
                  <td className="px-3 py-2">{formatNumber(summary.max)}</td>
                  <td className="px-3 py-2">
                    {formatNumber(summary.standardDeviation)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QualityFindings({ findings }: { findings: QualityFinding[] }) {
  if (findings.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No quality findings were reported.
      </p>
    );
  }

  const shownFindings = findings.slice(0, 12);
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {shownFindings.map((finding, index) => (
          <li
            className="rounded-lg bg-background/80 px-3 py-2 text-sm"
            key={`${finding.ruleId}-${finding.affectedField ?? "dataset"}-${index}`}
          >
            <p className="font-medium">
              {finding.severity} · {finding.ruleId}
              {finding.affectedField ? ` · ${finding.affectedField}` : ""}
            </p>
            <p className="mt-1 text-muted-foreground">{finding.message}</p>
          </li>
        ))}
      </ul>
      {findings.length > shownFindings.length && (
        <p className="text-xs text-muted-foreground">
          Showing {shownFindings.length} of {findings.length} findings.
        </p>
      )}
    </div>
  );
}

function MetricResultCard({ metric }: { metric: MetricResult }) {
  const formula = metric.assumptions.find((assumption) =>
    assumption.startsWith("Formula:"),
  );
  const assumptions = metric.assumptions.filter(
    (assumption) => assumption !== formula,
  );
  const dimensions = Object.entries(metric.dimensions)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
  const tableColumns = metric.table
    ? [...new Set(metric.table.flatMap((row) => Object.keys(row)))].slice(0, 8)
    : [];

  return (
    <div className="rounded-xl border border-border/70 bg-background/80 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {metricLabel(metric.metricId)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Definition {metric.definitionVersion}
            {dimensions ? ` · ${dimensions}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">
            {metricValue(metric)}
          </p>
          <p className="text-xs text-muted-foreground">
            {metric.validationStatus} validation
            {metric.qualityStatus ? ` · quality ${metric.qualityStatus}` : ""}
          </p>
        </div>
      </div>

      {formula && (
        <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Metric definition
          </p>
          <code className="mt-1 block whitespace-normal break-words text-xs">
            {formula.replace(/^Formula:\s*/, "")}
          </code>
        </div>
      )}

      {metric.table && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full min-w-[420px] text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {tableColumns.map((column) => (
                  <th className="px-3 py-2 font-medium" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {metric.table.slice(0, 12).map((row, index) => (
                <tr key={index}>
                  {tableColumns.map((column) => (
                    <td className="px-3 py-2" key={column}>
                      {displayCell(row[column] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {metric.table.length > 12 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Showing 12 of {metric.table.length} rows.
            </p>
          )}
        </div>
      )}

      {assumptions.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Assumptions ({assumptions.length})
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {assumptions.slice(0, 12).map((assumption, index) => (
              <li key={index}>{assumption}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function MetricComparisonChart({ metrics }: { metrics: MetricResult[] }) {
  const groups = new Map<string, MetricResult[]>();
  for (const metric of metrics) {
    if (metric.value === undefined) continue;
    const group = groups.get(metric.metricId) ?? [];
    group.push(metric);
    groups.set(metric.metricId, group);
  }

  const comparableGroups = [...groups.entries()].filter(
    ([, values]) => values.length > 1,
  );
  if (comparableGroups.length === 0) return null;

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-background/80 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Metric comparison by ticker
      </p>
      {comparableGroups.map(([metricId, values]) => {
        const maxMagnitude = Math.max(
          ...values.map((metric) => Math.abs(metric.value ?? 0)),
        );
        return (
          <section className="space-y-2" key={metricId}>
            <h4 className="text-sm font-semibold">{metricLabel(metricId)}</h4>
            {values.map((metric, index) => {
              const value = metric.value ?? 0;
              const width =
                maxMagnitude === 0 ? 0 : (Math.abs(value) / maxMagnitude) * 50;
              const left = value < 0 ? 50 - width : 50;
              const ticker = String(
                metric.dimensions.ticker ?? `Series ${index + 1}`,
              );
              return (
                <div
                  className="flex items-center gap-3"
                  key={`${ticker}-${index}`}
                >
                  <span className="w-14 shrink-0 text-xs font-medium">
                    {ticker}
                  </span>
                  <div
                    className="relative h-3 flex-1 rounded-full bg-muted"
                    role="img"
                    aria-label={`${ticker}: ${metricValue(metric)}`}
                  >
                    <span className="absolute inset-y-0 left-1/2 w-px bg-foreground/40" />
                    <span
                      className={`absolute inset-y-0 rounded-full ${
                        value < 0 ? "bg-orange-500" : "bg-blue-500"
                      }`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums">
                    {metricValue(metric)}
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}
      <p className="text-[11px] text-muted-foreground">
        Bars share a zero baseline; positive and negative values extend in
        opposite directions.
      </p>
    </div>
  );
}

export function FinanceAnalysisResult({
  result,
}: {
  result: AnalysisRunResult;
}) {
  const quality = result.qualityReport;
  const provenance = result.provenance;
  const statusLabel =
    result.status === "failed"
      ? "Failed"
      : quality?.gateOutcome === "blocked"
        ? "Quality blocked"
        : "Completed";

  return (
    <article className="w-full rounded-2xl border border-border/80 bg-background p-4 shadow-sm sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Governed finance result
          </p>
          <h2 className="mt-1 text-base font-semibold">{statusLabel}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Run {result.runId}
            {result.durationMs !== undefined
              ? ` · ${result.durationMs.toLocaleString()} ms`
              : ""}
          </p>
        </div>
        {quality && (
          <span className="rounded-full border border-border px-2.5 py-1 text-xs font-medium">
            Quality {qualityLabel(quality.status)} · gate {quality.gateOutcome}
          </span>
        )}
      </header>

      {result.error && (
        <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm font-medium">
            {result.error.category.replaceAll("-", " ")} error
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {result.error.message}
          </p>
        </div>
      )}

      {result.dataset && (
        <div className="mt-4 grid gap-2 rounded-xl bg-muted/40 p-3 text-xs sm:grid-cols-2">
          <p>
            <span className="font-medium">Dataset:</span>{" "}
            {result.dataset.version}
            {provenance?.source.fixtureId
              ? ` · ${provenance.source.fixtureId}`
              : ` · ${provenance?.source.type ?? "registered data"}`}
          </p>
          {provenance && (
            <p>
              <span className="font-medium">Source:</span>{" "}
              {provenance.source.provider} / {provenance.source.connector} ·{" "}
              {provenance.source.freshness}
            </p>
          )}
          <p className="font-mono text-muted-foreground">
            Hash: {shortHash(result.dataset.contentHash)}
          </p>
          {provenance && (
            <p className="text-muted-foreground">
              Observed {new Date(provenance.observedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {quality && (
        <section className="mt-4 space-y-3 rounded-xl bg-muted/40 p-3">
          <div>
            <h3 className="text-sm font-semibold">Quality gate</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {quality.evaluatedRules.length} rules evaluated at{" "}
              {new Date(quality.evaluatedAt).toLocaleString()}.
            </p>
          </div>
          <QualityFindings findings={quality.findings} />
        </section>
      )}

      {result.profile && (
        <div className="mt-4">
          <ProfileSummary profile={result.profile} />
        </div>
      )}

      {result.metrics.length > 0 && (
        <section className="mt-4 space-y-3">
          <h3 className="text-sm font-semibold">Finance metrics</h3>
          <MetricComparisonChart metrics={result.metrics} />
          {result.metrics.map((metric, index) => (
            <MetricResultCard
              key={`${metric.metricId}-${JSON.stringify(metric.dimensions)}-${index}`}
              metric={metric}
            />
          ))}
        </section>
      )}

      {quality?.gateOutcome === "blocked" && result.metrics.length === 0 && (
        <p className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          Metric calculation was blocked by the quality gate.
        </p>
      )}

      {result.status === "completed" && (
        <p className="mt-4 border-t border-border/70 pt-3 text-xs text-muted-foreground">
          Descriptive analysis of the registered observations; it does not
          predict future performance or provide investment advice.
        </p>
      )}
    </article>
  );
}
