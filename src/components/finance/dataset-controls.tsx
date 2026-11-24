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
import {
  ANALYSIS_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isAbortError,
  requestJson,
  responseError,
} from "@/components/finance/api-request";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (result: AnalysisRunResult) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
};

type ApiAction = "fixture" | "upload" | "profile" | "delete" | FinanceMetricId;

// A 401 clears stale session cookies; one retry then gets a fresh session.
const MAX_AUTH_RECOVERY_ATTEMPTS = 1;
const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;

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

  const lifecycleRef = useRef<AbortController | null>(null);
  const refreshSequenceRef = useRef(0);

  // Abort in-flight requests when the controls unmount.
  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => controller.abort();
  }, []);

  const request = useCallback(
    (
      url: string,
      init: RequestInit & { timeoutMs?: number; timeoutMessage?: string },
    ) =>
      requestJson(url, {
        credentials: "same-origin",
        signal: lifecycleRef.current?.signal,
        ...init,
      }),
    [],
  );

  const refreshDatasets = useCallback(
    async (preferredDatasetId?: string) => {
      const sequence = (refreshSequenceRef.current += 1);
      setIsLoadingDatasets(true);
      setErrorMessage(null);
      try {
        let listing: unknown;
        for (
          let attempt = 0;
          attempt <= MAX_AUTH_RECOVERY_ATTEMPTS;
          attempt += 1
        ) {
          const { ok, status, payload } = await request("/api/datasets", {
            cache: "no-store",
            timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            timeoutMessage:
              "Loading the dataset catalog took too long. Use Refresh to try again.",
          });
          if (status === 401 && attempt < MAX_AUTH_RECOVERY_ATTEMPTS) {
            continue;
          }
          if (!ok) {
            throw new Error(
              responseError(payload, "Unable to load registered datasets."),
            );
          }
          listing =
            typeof payload === "object" &&
            payload !== null &&
            "datasets" in payload
              ? { datasets: payload.datasets }
              : payload;
          break;
        }
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
        if (isAbortError(error)) return;
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Unable to load registered datasets.",
        );
      } finally {
        // Only the most recent refresh owns the loading indicator.
        if (sequence === refreshSequenceRef.current) {
          setIsLoadingDatasets(false);
        }
      }
    },
    [request],
  );

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

  function reportActionError(error: unknown, fallback: string) {
    if (isAbortError(error)) return;
    setErrorMessage(error instanceof Error ? error.message : fallback);
  }

  async function registerFixture() {
    beginAction("fixture");
    try {
      const { ok, payload } = await request("/api/datasets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "fixture" }),
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        timeoutMessage:
          "Registering the finance fixture took too long and was cancelled. Please try again.",
      });
      if (!ok) {
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
      reportActionError(error, "Unable to register the finance fixture.");
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
      const { ok, payload } = await request("/api/datasets", {
        method: "POST",
        headers: { "Content-Type": "text/csv; charset=utf-8" },
        body: file,
        timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
        timeoutMessage:
          "Uploading this CSV took too long and was cancelled. Please try again.",
      });
      if (!ok) {
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
      reportActionError(error, "Unable to register this CSV file.");
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
      const { ok, payload } = await request("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        timeoutMs: ANALYSIS_REQUEST_TIMEOUT_MS,
        timeoutMessage:
          "The analysis took longer than a minute and was cancelled. Please try again.",
      });
      if (!ok) {
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
          ? "Metric analysis finished. Review the result in the conversation."
          : "Profile and quality analysis finished. Review the result in the conversation.",
      );
    } catch (error) {
      reportActionError(error, "Unable to run this finance analysis.");
    } finally {
      endAction();
    }
  }

  async function deleteSelectedDataset() {
    const datasetId = selectedDatasetId;
    if (!datasetId) return;

    beginAction("delete");
    try {
      const { ok, payload } = await request(
        `/api/datasets?datasetId=${encodeURIComponent(datasetId)}`,
        {
          method: "DELETE",
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          timeoutMessage:
            "Removing this dataset took too long and was cancelled. Please try again.",
        },
      );
      if (!ok) {
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
      // Keep the confirmation open so the failure is shown where the user is.
      reportActionError(error, "Unable to remove this dataset.");
    } finally {
      endAction();
    }
  }

  const selectedDataset = datasets.find(
    (entry) => entry.dataset.datasetId === selectedDatasetId,
  );
  const busy = disabled || pendingAction !== null;

  const errorAlert = errorMessage && (
    <p
      className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      {errorMessage}
    </p>
  );

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-2">
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
              <Badge
                variant="secondary"
                className="ml-1 px-1.5 py-0 text-[10px]"
              >
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
            className="z-50 max-h-[min(72dvh,36rem)] w-[min(46rem,calc(100vw-1.5rem))] gap-0 overflow-y-auto rounded-2xl border border-border/80 bg-background p-4 shadow-2xl sm:p-5"
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
                    Register a sample or upload a CSV to profile it or calculate
                    a metric.
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
                      onClick={() => {
                        setErrorMessage(null);
                        setIsDeleteConfirmationOpen(true);
                      }}
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
                    {selectedDataset.schema
                      .map((field) => field.name)
                      .join(", ")}
                  </span>
                  <span>
                    Expires:{" "}
                    {new Date(selectedDataset.expiresAt).toLocaleString()}
                  </span>
                </div>
              )}

              {errorAlert && <div className="mt-3">{errorAlert}</div>}
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
          onOpenChange={(nextOpen) => {
            // A removal in flight cannot be cancelled by dismissing the dialog.
            if (!nextOpen && pendingAction === "delete") return;
            setIsDeleteConfirmationOpen(nextOpen);
          }}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Remove registered dataset?</DialogTitle>
              <DialogDescription>
                Remove the selected {selectedDataset?.source.type ?? "finance"}{" "}
                dataset (
                {selectedDataset?.rowCount.toLocaleString() ?? "unknown"} rows)
                from this session&apos;s catalog? It will no longer be available
                for new analyses. Results already shown in the conversation are
                not affected.
              </DialogDescription>
            </DialogHeader>
            {errorAlert}
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
      {/* The panel and dialog show their own copy of the error; this one
          covers the case where both are closed. */}
      {errorAlert && !open && !isDeleteConfirmationOpen && (
        <div className="mt-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">{errorAlert}</div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss finance data error"
            title="Dismiss"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
