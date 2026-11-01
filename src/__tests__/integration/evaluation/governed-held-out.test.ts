import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { financeAnalysisWorkflow } from "@/mastra/workflows/finance-analysis";
import { heldOutTaskSet, runEvaluationTask } from "@/mastra/evaluation/runner";

beforeAll(() => {
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("governed held-out deterministic tasks", () => {
  it("matches the declared metric, profile, and quality expectations", async () => {
    const deterministicTasks = heldOutTaskSet.tasks.filter(
      (task) => task.fixture && task.workflowInput,
    );

    expect(deterministicTasks.length).toBeGreaterThanOrEqual(20);
    for (const task of deterministicTasks) {
      const run = await runEvaluationTask(task, "governed");
      expect(
        run.score.passed,
        `${task.taskId}: ${run.score.notes.join(" ")}`,
      ).toBe(true);
      expect(run.record.status).toBe("completed");
    }
  }, 15_000);
});
