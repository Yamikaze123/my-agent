import type { DatasetCatalogEntry } from "@/mastra/contracts/finance";

function rowCountLabel(rowCount: number): string {
  return `${rowCount.toLocaleString()} ${rowCount === 1 ? "row" : "rows"}`;
}

/** A compact, filename-free label for the Finance data dataset selector. */
export function datasetDisplayLabel(entry: DatasetCatalogEntry): string {
  const rowCount = rowCountLabel(entry.rowCount);

  if (entry.source.type === "fixture") {
    const version = entry.dataset.version.startsWith("v")
      ? entry.dataset.version
      : `v${entry.dataset.version}`;
    return `Finance fixture · ${rowCount} · ${version}`;
  }

  const createdAt = new Date(entry.createdAt);
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? "time unknown"
    : createdAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  const shortId = entry.dataset.datasetId
    .replace(/-/g, "")
    .slice(0, 6)
    .toUpperCase();
  const sourceLabel =
    entry.source.type === "upload" ? "CSV upload" : "Finance dataset";

  return `${sourceLabel} · ${rowCount} · ${createdLabel} · ${shortId}`;
}
