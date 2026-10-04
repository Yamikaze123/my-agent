import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { registerFinanceFixture } from "@/mastra/datasets/catalog";
import { resolvePermissionContext } from "@/mastra/security/permission-context";
import {
  financeAnalysisWorkflow,
  runFinanceAnalysisWorkflow,
} from "@/mastra/workflows/finance-analysis";

// This file registers the workflow with a storage-backed Mastra instance on
// purpose. It is kept separate so the registration does not affect the other
// workflow tests, which exercise the unregistered module.
beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("core workflow run persistence", () => {
  it("leaves no run snapshot in storage when registered with a Mastra instance", async () => {
    const storage = new InMemoryStore({ id: "test-workflow-storage" });
    new Mastra({
      storage,
      workflows: { financeAnalysisWorkflow },
    });

    const context = resolvePermissionContext(
      new Request("http://localhost/api/datasets"),
    ).permissionContext;
    const entry = registerFinanceFixture(context);
    const result = await runFinanceAnalysisWorkflow(
      context,
      entry.dataset.datasetId,
    );
    expect(result.status).toBe("completed");

    const workflowsStore = await storage.getStore("workflows");
    expect(workflowsStore).toBeDefined();
    const runs = await workflowsStore!.listWorkflowRuns({
      workflowName: financeAnalysisWorkflow.id,
    });
    expect(runs.total).toBe(0);
    expect(runs.runs).toEqual([]);
  });
});
