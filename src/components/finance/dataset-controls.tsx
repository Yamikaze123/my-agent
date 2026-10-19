"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  analysisRunResultSchema,
  datasetCatalogEntrySchema,
  financeAnalysisInputSchema,
  financeDatasetListResultSchema,
  type AnalysisRunResult,
  type DatasetCatalogEntry,
  type FinanceMetricId,
} from "@/mastra/contracts/finance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DatabaseIcon,
  FileSpreadsheetIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { datasetDisplayLabel } from "@/components/finance/dataset-display-label";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (result: AnalysisRunResult) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
};

type ApiAction = "fixture" | "upload" | "profile" | "delete" | FinanceMetricId;

async function responseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function responseError(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

function registeredEntry(payload: unknown): DatasetCatalogEntry {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("dataset" in payload)
  ) {
    throw new Error("The dataset registration response was invalid.");
  }
  const parsed = datasetCatalogEntrySchema.safeParse(payload.dataset);
  if (!parsed.success) {
    throw new Error("The dataset registration response was invalid.");
  }
  return parsed.data;
}

const METRICS: ReadonlyArray<{ id: FinanceMetricId; label: string }> = [
  { id: "total-return", label: "Total return" },
  { id: "volatility", label: "Annualized volatility" },
  { id: "maximum-drawdown", label: "Maximum drawdown" },
];

export function FinanceDatasetControls({
  open,
  onOpenChange,
  onResult,
  onBusyChange,
  disabled,
}: Props) {
  const [datasets, setDatasets] = useState<DatasetCatalogEntry[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [isLoadingDatasets, setIsLoadingDatasets] = useState(false);
  const [pendingAction, setPendingAction] = useState<ApiAction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] =
    useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshDatasets = useCallback(async (preferredDatasetId?: string) => {
    setIsLoadingDatasets(true);
    setErrorMessage(null);
    try {
      const response = await fetch("/api/datasets", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        throw new Error(
          responseError(payload, "Unable to load registered datasets."),
        );
      }
      const listing =
        typeof payload === "object" && payload !== null && "datasets" in payload
          ? { datasets: payload.datasets }
          : payload;
      const parsed = financeDatasetListResultSchema.safeParse(listing);
      if (!parsed.success) {
        throw new Error("The dataset catalog response was invalid.");
      }

      setDatasets(parsed.data.datasets);
      setSelectedDatasetId((current) => {
        if (
          preferredDatasetId &&
          parsed.data.datasets.some(
            (entry) => entry.dataset.datasetId === preferredDatasetId,
          )
        ) {
          return preferredDatasetId;
        }
        if (
          current &&
          parsed.data.datasets.some(
            (entry) => entry.dataset.datasetId === current,
          )
        ) {
          return current;
        }
        return parsed.data.datasets[0]?.dataset.datasetId ?? "";
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to load registered datasets.",
      );
    } finally {
      setIsLoadingDatasets(false);
    }
  }, []);

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  function beginAction(action: ApiAction) {
    setPendingAction(action);
    setErrorMessage(null);
    setNotice(null);
    onBusyChange(true);
  }

  function endAction() {
    setPendingAction(null);
    onBusyChange(false);
  }

  async function registerFixture() {
    beginAction("fixture");
    try {
      const response = await fetch("/api/datasets", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "fixture" }),
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        throw new Error(
          responseError(payload, "Unable to register the finance fixture."),
        );
      }

      const entry = registeredEntry(payload);
      setDatasets((current) => [
        entry,
        ...current.filter(
          (candidate) =>
            candidate.dataset.datasetId !== entry.dataset.datasetId,
        ),
      ]);
      setSelectedDatasetId(entry.dataset.datasetId);
      setNotice("Versioned finance fixture registered.");
      await refreshDatasets(entry.dataset.datasetId);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to register the finance fixture.",
      );
    } finally {
      endAction();
    }
  }

  async function uploadCsv(file: File, input: HTMLInputElement) {
    beginAction("upload");
    try {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        throw new Error("Choose a file with a .csv extension.");
      }
      const response = await fetch("/api/datasets", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "text/csv; charset=utf-8" },
        body: file,
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        throw new Error(
          responseError(payload, "Unable to register this CSV file."),
        );
      }

      const entry = registeredEntry(payload);
      setDatasets((current) => [
        entry,
        ...current.filter(
          (candidate) =>
            candidate.dataset.datasetId !== entry.dataset.datasetId,
        ),
      ]);
      setSelectedDatasetId(entry.dataset.datasetId);
      setNotice(
        "CSV registered. Its schema and row count are ready to profile.",
      );
      await refreshDatasets(entry.dataset.datasetId);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to register this CSV file.",
      );
    } finally {
      input.value = "";
      endAction();
    }
  }

  async function runAnalysis(metricId?: FinanceMetricId) {
    if (!selectedDatasetId) return;
    const action = metricId ?? "profile";
    beginAction(action);
    try {
      const input = financeAnalysisInputSchema.parse({
        datasetId: selectedDatasetId,
        ...(metricId ? { metricId } : {}),
      });
      const response = await fetch("/api/analysis", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        throw new Error(
          responseError(payload, "Unable to run this finance analysis."),
        );
      }

      const parsed = analysisRunResultSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("The finance analysis response was invalid.");
      }
      onResult(parsed.data);
      setNotice(
        metricId
          ? "Metric analysis finished. Review the typed result in the conversation."
          : "Profile and quality analysis finished. Review the typed result in the conversation.",
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to run this finance analysis.",
      );
    } finally {
      endAction();
    }
  }

  async function deleteSelectedDataset() {
    const datasetId = selectedDatasetId;
    if (!datasetId) return;

    beginAction("delete");
    try {
      const response = await fetch(
        `/api/datasets?datasetId=${encodeURIComponent(datasetId)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
        },
      );
      const payload = await responseJson(response);
      if (!response.ok) {
        throw new Error(
          responseError(payload, "Unable to remove this dataset."),
        );
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("deleted" in payload) ||
        payload.deleted !== true
      ) {
        throw new Error("The dataset deletion response was invalid.");
      }

      setIsDeleteConfirmationOpen(false);
      setDatasets((current) =>
        current.filter((entry) => entry.dataset.datasetId !== datasetId),
      );
      setSelectedDatasetId("");
      setNotice("Dataset removed from the catalog.");
      await refreshDatasets();
    } catch (error) {
      setIsDeleteConfirmationOpen(false);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to remove this dataset.",
      );
    } finally {
      endAction();
    }
  }

  const selectedDataset = datasets.find(
    (entry) => entry.dataset.datasetId === selectedDatasetId,
  );
  const busy = disabled || pendingAction !== null;

  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={open}
            aria-controls="finance-dataset-panel"
            disabled={disabled && !open}
            className="h-9 gap-2 rounded-xl"
          >
            <DatabaseIcon className="size-4" />
            Finance data
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
              {datasets.length}
            </Badge>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          id="finance-dataset-panel"
          aria-labelledby="finance-dataset-title"
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          className="z-[100] max-h-[min(72vh,36rem)] w-[min(46rem,calc(100vw-1.5rem))] gap-0 overflow-y-auto rounded-2xl border border-border/80 bg-background p-4 shadow-2xl sm:p-5"
        >
          <section aria-labelledby="finance-dataset-title">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2
                  id="finance-dataset-title"
                  className="text-sm font-semibold"
                >
                  Finance data
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Register a sample or upload a CSV to profile it or calculate a
                  metric.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshDatasets()}
                  disabled={busy || isLoadingDatasets}
                  className="h-8 gap-1.5 px-2"
                >
                  <RefreshCwIcon
                    className={`size-3.5 ${isLoadingDatasets ? "animate-spin" : ""}`}
                  />
                  <span className="hidden sm:inline">Refresh</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close finance data panel"
                  title="Close"
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void registerFixture()}
                disabled={busy}
                className="h-9 gap-2 rounded-xl"
              >
                <DatabaseIcon className="size-3.5" />
                {pendingAction === "fixture"
                  ? "Registering…"
                  : "Register fixture"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="h-9 gap-2 rounded-xl"
              >
                <UploadIcon className="size-3.5" />
                {pendingAction === "upload" ? "Uploading…" : "Upload CSV"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="Choose a finance CSV file"
                disabled={busy}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  if (file) void uploadCsv(file, input);
                }}
              />
            </div>

            {datasets.length > 0 ? (
              <div className="mt-3 grid gap-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium">Dataset</span>
                    <select
                      value={selectedDatasetId}
                      onChange={(event) =>
                        setSelectedDatasetId(event.target.value)
                      }
                      disabled={busy}
                      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {datasets.map((entry) => (
                        <option
                          key={entry.dataset.datasetId}
                          value={entry.dataset.datasetId}
                        >
                          {datasetDisplayLabel(entry)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => setIsDeleteConfirmationOpen(true)}
                    disabled={busy || !selectedDatasetId}
                    className="h-10 gap-2 rounded-xl"
                  >
                    <Trash2Icon className="size-3.5" />
                    Remove dataset
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 border-t border-border/70 pt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void runAnalysis()}
                    disabled={busy || !selectedDatasetId}
                    className="h-9 gap-1.5 rounded-xl"
                  >
                    <FileSpreadsheetIcon className="size-3.5" />
                    {pendingAction === "profile"
                      ? "Profiling…"
                      : "Profile & quality"}
                  </Button>
                  {METRICS.map((metric) => (
                    <Button
                      key={metric.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void runAnalysis(metric.id)}
                      disabled={busy || !selectedDatasetId}
                      className="h-9 rounded-xl"
                    >
                      {pendingAction === metric.id
                        ? "Calculating…"
                        : metric.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                {isLoadingDatasets
                  ? "Loading the dataset catalog…"
                  : "No datasets are registered for this session yet."}
              </p>
            )}

            {selectedDataset && (
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Fields:{" "}
                  {selectedDataset.schema.map((field) => field.name).join(", ")}
                </span>
                <span>
                  Expires:{" "}
                  {new Date(selectedDataset.expiresAt).toLocaleString()}
                </span>
              </div>
            )}

            {errorMessage && (
              <p
                className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {errorMessage}
              </p>
            )}
            {notice && (
              <p
                className="mt-2 text-xs text-muted-foreground"
                aria-live="polite"
              >
                {notice}
              </p>
            )}
          </section>
        </PopoverContent>
      </Popover>

      <Dialog
        open={isDeleteConfirmationOpen}
        onOpenChange={setIsDeleteConfirmationOpen}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove registered dataset?</DialogTitle>
            <DialogDescription>
              Remove the selected {selectedDataset?.source.type ?? "finance"}{" "}
              dataset ({selectedDataset?.rowCount.toLocaleString() ?? "unknown"}{" "}
              rows) from this session&apos;s catalog? It will no longer be
              available for new analyses. Existing results will remain in the
              conversation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={pendingAction === "delete"}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void deleteSelectedDataset()}
              disabled={!selectedDatasetId || pendingAction === "delete"}
            >
              {pendingAction === "delete" ? "Removing…" : "Remove dataset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedDataset && (
        <span className="max-w-[60%] truncate text-xs text-muted-foreground">
          {selectedDataset.dataset.version} ·{" "}
          {selectedDataset.rowCount.toLocaleString()} rows
        </span>
      )}
    </div>
  );
}
