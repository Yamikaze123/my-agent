import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PANEL_RESULTS,
  MAX_PANEL_RESULTS,
  PANEL_RESULTS_STORAGE_KEY,
  appendPanelResult,
  buildTimeline,
  loadPanelResults,
  parseStoredPanelResults,
  savePanelResults,
  serializePanelResults,
  type PanelResultsState,
} from "@/components/finance/panel-results";
import {
  analysisRunResultSchema,
  type AnalysisRunResult,
} from "@/mastra/contracts/finance";

function failedRun(): AnalysisRunResult {
  return analysisRunResultSchema.parse({
    runId: randomUUID(),
    resourceId: randomUUID(),
    status: "failed",
    idempotencyKey: "panel-results-test",
    metrics: [],
    stdoutPreview: "",
    stderrPreview: "",
    artifacts: [],
    createdAt: "2026-01-01T00:00:00Z",
    retryCount: 0,
    error: { category: "validation", message: "Not enough observations." },
  });
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("appendPanelResult", () => {
  it("anchors each result to the message count when it arrived", () => {
    const first = failedRun();
    const second = failedRun();
    let state = appendPanelResult(EMPTY_PANEL_RESULTS, first, 2);
    state = appendPanelResult(state, second, 4);

    expect(state.entries.map((entry) => entry.afterMessageCount)).toEqual([
      2, 4,
    ]);
    expect(state.droppedCount).toBe(0);
  });

  it("drops the oldest results beyond the cap and counts them", () => {
    let state: PanelResultsState = EMPTY_PANEL_RESULTS;
    const runs = Array.from({ length: MAX_PANEL_RESULTS + 3 }, failedRun);
    for (const run of runs) state = appendPanelResult(state, run, 0);

    expect(state.entries).toHaveLength(MAX_PANEL_RESULTS);
    expect(state.droppedCount).toBe(3);
    expect(state.entries[0].result.runId).toBe(runs[3].runId);
    expect(state.entries.at(-1)?.result.runId).toBe(runs.at(-1)?.runId);
  });

  it("replaces a result that arrives twice instead of duplicating it", () => {
    const run = failedRun();
    const state = appendPanelResult(
      appendPanelResult(EMPTY_PANEL_RESULTS, run, 0),
      run,
      2,
    );
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].afterMessageCount).toBe(2);
  });
});

describe("stored panel results", () => {
  it("round-trips a valid state", () => {
    const state = appendPanelResult(EMPTY_PANEL_RESULTS, failedRun(), 3);
    expect(parseStoredPanelResults(serializePanelResults(state))).toEqual(
      state,
    );
  });

  it("returns the empty state for missing, malformed or mis-shaped data", () => {
    expect(parseStoredPanelResults(null)).toEqual(EMPTY_PANEL_RESULTS);
    expect(parseStoredPanelResults("{not json")).toEqual(EMPTY_PANEL_RESULTS);
    expect(parseStoredPanelResults('{"entries":"nope"}')).toEqual(
      EMPTY_PANEL_RESULTS,
    );
  });

  it("discards entries that fail the analysis result schema", () => {
    const valid = failedRun();
    const raw = JSON.stringify({
      droppedCount: 1,
      entries: [
        { result: { runId: "not-a-run" }, afterMessageCount: 0 },
        { result: valid, afterMessageCount: 2 },
      ],
    });
    const state = parseStoredPanelResults(raw);
    expect(state.entries.map((entry) => entry.result.runId)).toEqual([
      valid.runId,
    ]);
    expect(state.droppedCount).toBe(1);
  });

  it("saves, loads and clears through a storage object", () => {
    const storage = memoryStorage();
    const state = appendPanelResult(EMPTY_PANEL_RESULTS, failedRun(), 1);

    expect(savePanelResults(state, storage)).toBe(true);
    expect(loadPanelResults(storage)).toEqual(state);

    savePanelResults(EMPTY_PANEL_RESULTS, storage);
    expect(storage.values.has(PANEL_RESULTS_STORAGE_KEY)).toBe(false);
  });

  it("survives storage that is unavailable or throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    const state = appendPanelResult(EMPTY_PANEL_RESULTS, failedRun(), 0);

    expect(loadPanelResults(throwing)).toEqual(EMPTY_PANEL_RESULTS);
    expect(savePanelResults(state, throwing)).toBe(false);
    expect(loadPanelResults(undefined)).toEqual(EMPTY_PANEL_RESULTS);
    expect(savePanelResults(state, undefined)).toBe(false);
  });
});

describe("buildTimeline", () => {
  const describeItem = (
    item: ReturnType<typeof buildTimeline<string>>[number],
  ) =>
    item.kind === "message"
      ? item.message
      : `result@${item.entry.afterMessageCount}`;

  it("places each result after the messages that preceded it", () => {
    let state = appendPanelResult(EMPTY_PANEL_RESULTS, failedRun(), 0);
    state = appendPanelResult(state, failedRun(), 2);
    state = appendPanelResult(state, failedRun(), 2);

    const timeline = buildTimeline(["m1", "m2", "m3"], state.entries);
    expect(timeline.map(describeItem)).toEqual([
      "result@0",
      "m1",
      "m2",
      "result@2",
      "result@2",
      "m3",
    ]);
  });

  it("puts results anchored beyond the thread at the end", () => {
    const state = appendPanelResult(EMPTY_PANEL_RESULTS, failedRun(), 9);
    expect(buildTimeline(["m1"], state.entries).map(describeItem)).toEqual([
      "m1",
      "result@9",
    ]);
    expect(buildTimeline([], state.entries).map(describeItem)).toEqual([
      "result@9",
    ]);
  });
});
