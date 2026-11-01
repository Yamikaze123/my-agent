import { beforeEach, describe, expect, it } from "vitest";
import {
  collectionTaskContextForTask,
  setCollectionTaskContext,
} from "@/mastra/evaluation/collection-fixture";
import { getCollectionFixtureTool } from "@/mastra/evaluation/collection-fixture-tool";
import { heldOutTaskSet } from "@/mastra/evaluation/runner";
import {
  createMastraRequestContext,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";

function context() {
  const permissionContext = resolvePermissionContext(
    new Request("http://localhost/evaluation/provider"),
  ).permissionContext;
  return {
    permissionContext,
    requestContext: createMastraRequestContext(permissionContext),
  };
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("getCollectionFixtureTool", () => {
  it("returns the checksum-verified JSON fixture selected by the task", async () => {
    const task = heldOutTaskSet.tasks.find(
      (candidate) => candidate.taskId === "metric-v1-total-aapl",
    )!;
    const selected = collectionTaskContextForTask(task);
    const authorized = context();
    setCollectionTaskContext(authorized.requestContext, selected!);

    const result = (await getCollectionFixtureTool.execute!(
      {},
      { requestContext: authorized.requestContext },
    )) as { fixtureId: string; contentHash: string; rows: unknown[] };

    expect(result.fixtureId).toBe("finance-regression");
    expect(result.contentHash).toBe(task.fixture?.contentHash);
    expect(result.rows).toHaveLength(39);
  });

  it("loads defective CSV bytes without allowing the model to choose a path", async () => {
    const task = heldOutTaskSet.tasks.find(
      (candidate) => candidate.taskId === "quality-prompt-injection-data",
    )!;
    const selected = collectionTaskContextForTask(task);
    const authorized = context();
    setCollectionTaskContext(authorized.requestContext, selected!);

    const result = (await getCollectionFixtureTool.execute!(
      {},
      { requestContext: authorized.requestContext },
    )) as { taskId: string; contentHash: string; rows: unknown[] };

    expect(result.taskId).toBe(task.taskId);
    expect(result.contentHash).toBe(task.fixture?.contentHash);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("requires both permission context and a harness binding", async () => {
    await expect(getCollectionFixtureTool.execute!({}, {})).rejects.toThrow(
      /Unauthorized/,
    );

    const authorized = context();
    await expect(
      getCollectionFixtureTool.execute!(
        {},
        { requestContext: authorized.requestContext },
      ),
    ).rejects.toThrow(/fixture is bound/);
  });
});
