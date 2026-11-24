import { z } from "zod";
import {
  analysisRunResultSchema,
  type AnalysisRunResult,
} from "@/mastra/contracts/finance";

// Results run from the "Finance data" panel are not part of the server-side
// chat thread. They are kept for the browser session and anchored to the
// number of chat messages that existed when they arrived, so they stay in
// order relative to the conversation.

export const PANEL_RESULTS_STORAGE_KEY = "finance-panel-results:v1";
export const MAX_PANEL_RESULTS = 8;

export type PanelResultEntry = {
  result: AnalysisRunResult;
  afterMessageCount: number;
};

export type PanelResultsState = {
  entries: PanelResultEntry[];
  // How many older results were removed to stay within MAX_PANEL_RESULTS.
  droppedCount: number;
};

export const EMPTY_PANEL_RESULTS: PanelResultsState = {
  entries: [],
  droppedCount: 0,
};

const storedPanelResultsSchema = z.object({
  entries: z.array(
    z.object({
      result: z.unknown(),
      afterMessageCount: z.number().int().min(0),
    }),
  ),
  droppedCount: z.number().int().min(0),
});

function capEntries(
  entries: PanelResultEntry[],
  droppedCount: number,
): PanelResultsState {
  const overflow = Math.max(0, entries.length - MAX_PANEL_RESULTS);
  return {
    entries: overflow > 0 ? entries.slice(overflow) : entries,
    droppedCount: droppedCount + overflow,
  };
}

export function appendPanelResult(
  state: PanelResultsState,
  result: AnalysisRunResult,
  messageCount: number,
): PanelResultsState {
  const entry: PanelResultEntry = {
    result,
    afterMessageCount: Math.max(0, Math.trunc(messageCount)),
  };
  return capEntries(
    [
      ...state.entries.filter(
        (existing) => existing.result.runId !== result.runId,
      ),
      entry,
    ],
    state.droppedCount,
  );
}

export function serializePanelResults(state: PanelResultsState): string {
  return JSON.stringify(state);
}

// Stored data is untrusted: anything that does not validate is discarded.
export function parseStoredPanelResults(raw: string | null): PanelResultsState {
  if (!raw) return EMPTY_PANEL_RESULTS;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return EMPTY_PANEL_RESULTS;
  }
  const envelope = storedPanelResultsSchema.safeParse(candidate);
  if (!envelope.success) return EMPTY_PANEL_RESULTS;

  const entries: PanelResultEntry[] = [];
  const seen = new Set<string>();
  let previousAnchor = 0;
  for (const stored of envelope.data.entries) {
    const parsed = analysisRunResultSchema.safeParse(stored.result);
    if (!parsed.success || seen.has(parsed.data.runId)) continue;
    seen.add(parsed.data.runId);
    // Anchors only ever grow; repair any that do not.
    previousAnchor = Math.max(previousAnchor, stored.afterMessageCount);
    entries.push({ result: parsed.data, afterMessageCount: previousAnchor });
  }
  return capEntries(entries, envelope.data.droppedCount);
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function loadPanelResults(
  storage: StorageLike | undefined = sessionStore(),
): PanelResultsState {
  try {
    return parseStoredPanelResults(
      storage?.getItem(PANEL_RESULTS_STORAGE_KEY) ?? null,
    );
  } catch {
    return EMPTY_PANEL_RESULTS;
  }
}

// Returns false when the results could not be stored (storage unavailable or
// full); they then last only until the page is reloaded.
export function savePanelResults(
  state: PanelResultsState,
  storage: StorageLike | undefined = sessionStore(),
): boolean {
  if (!storage) return false;
  try {
    if (state.entries.length === 0 && state.droppedCount === 0) {
      storage.removeItem(PANEL_RESULTS_STORAGE_KEY);
    } else {
      storage.setItem(PANEL_RESULTS_STORAGE_KEY, serializePanelResults(state));
    }
    return true;
  } catch {
    return false;
  }
}

export type TimelineItem<TMessage> =
  | { kind: "message"; message: TMessage }
  | { kind: "panel-result"; entry: PanelResultEntry };

// Interleaves panel results with chat messages: each result appears after the
// messages that existed when it arrived. Anchors beyond the current message
// count (for example after the thread was shortened) fall at the end.
export function buildTimeline<TMessage>(
  messages: readonly TMessage[],
  entries: readonly PanelResultEntry[],
): TimelineItem<TMessage>[] {
  const timeline: TimelineItem<TMessage>[] = [];
  let next = 0;
  for (let index = 0; index <= messages.length; index += 1) {
    while (
      next < entries.length &&
      (entries[next].afterMessageCount <= index || index === messages.length)
    ) {
      timeline.push({ kind: "panel-result", entry: entries[next] });
      next += 1;
    }
    if (index < messages.length) {
      timeline.push({ kind: "message", message: messages[index] });
    }
  }
  return timeline;
}
