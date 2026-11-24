export type ObservationFrequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annual";

export type InferredObservationFrequency = {
  frequency: ObservationFrequency;
  /** Return periods per year used to annualize a per-period statistic. */
  periodsPerYear: number;
  /** Lower-quartile calendar-day gap between consecutive observations. */
  typicalGapDays: number;
};

// Typical calendar-day gap between consecutive observations. The ranges leave
// room for weekends and holidays (daily), month lengths (monthly), and
// quarter lengths; a gap outside every range is reported as unclassified
// rather than forced into the nearest bucket.
const FREQUENCY_BANDS: ReadonlyArray<{
  frequency: ObservationFrequency;
  periodsPerYear: number;
  minGapDays: number;
  maxGapDays: number;
}> = [
  { frequency: "daily", periodsPerYear: 252, minGapDays: 1, maxGapDays: 4 },
  { frequency: "weekly", periodsPerYear: 52, minGapDays: 5, maxGapDays: 9 },
  { frequency: "monthly", periodsPerYear: 12, minGapDays: 26, maxGapDays: 35 },
  { frequency: "quarterly", periodsPerYear: 4, minGapDays: 85, maxGapDays: 97 },
  { frequency: "annual", periodsPerYear: 1, minGapDays: 358, maxGapDays: 372 },
];

const MS_PER_DAY = 86_400_000;

function utcDay(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
}

/**
 * Infer how often a series is observed from the spacing of its dates.
 * `dates` are YYYY-MM-DD strings in any order; duplicates are ignored. The
 * lower-quartile gap is used rather than the median because missing
 * observations only ever widen gaps: a monthly series with several skipped
 * months still has its one-month spacing in the lower quartile, while its
 * median may fall between frequencies. Returns undefined when fewer than two
 * distinct dates exist or the spacing matches no supported frequency.
 */
export function inferObservationFrequency(
  dates: readonly string[],
): InferredObservationFrequency | undefined {
  const days = [...new Set(dates)].map(utcDay).sort((a, b) => a - b);
  if (days.length < 2 || days.some((day) => !Number.isFinite(day))) {
    return undefined;
  }

  const gaps = days
    .slice(1)
    .map((day, index) => Math.round((day - days[index]) / MS_PER_DAY))
    .sort((a, b) => a - b);
  const typicalGapDays = gaps[Math.floor((gaps.length - 1) * 0.25)];

  const band = FREQUENCY_BANDS.find(
    ({ minGapDays, maxGapDays }) =>
      typicalGapDays >= minGapDays && typicalGapDays <= maxGapDays,
  );
  return band
    ? {
        frequency: band.frequency,
        periodsPerYear: band.periodsPerYear,
        typicalGapDays,
      }
    : undefined;
}
