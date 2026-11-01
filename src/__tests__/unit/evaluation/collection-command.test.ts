import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent } from "@mastra/core/agent";
import { describe, expect, it, vi } from "vitest";
import {
  environmentManifest,
  heldOutTaskSet,
} from "@/mastra/evaluation/runner";
import {
  createCollectionManifest,
  sha256Content,
} from "@/mastra/evaluation/collection";
import {
  freezeCollectionManifest,
  runCollectionCommand,
  type CollectionAgentMap,
  type CollectionCommandOptions,
} from "@/mastra/evaluation/collection-command";
import {
  readCollectionBatch,
  writeImmutableCollectionManifest,
} from "@/mastra/evaluation/measurement-record";
import { resolvePermissionContext } from "@/mastra/security/permission-context";

const SOURCE_COMMIT = "c".repeat(40);

function fakeAgent() {
  const generate = vi.fn(async () => ({
    text: "I can't help with that request.",
    error: undefined,
    totalUsage: { inputTokens: 12, outputTokens: 8 },
    steps: [{}],
    toolCalls: [],
    traceId: "collection-command-trace",
  }));
  return {
    agent: { generate } as unknown as Agent,
    generate,
  };
}

function setupCollectionCommand() {
  const rootDir = mkdtempSync(join(tmpdir(), "collection-command-"));
  const environment = {
    ...environmentManifest,
    candidateVersion: "collection-command-test",
    sourceCommit: SOURCE_COMMIT,
  };
  const manifest = createCollectionManifest({
    manifestVersion: "collection-command-v1",
    measurementBatchId: "collection-command-batch",
    candidateVersion: "collection-command-test",
    sourceCommit: SOURCE_COMMIT,
    environmentManifest: environment,
    environmentManifestHash: sha256Content(JSON.stringify(environment)),
    resultLocation: "evaluation/results/collection-command.json",
    inputPriceUsdPerMillionTokens: 0.2,
    outputPriceUsdPerMillionTokens: 0.4,
  });
  const taskSet = {
    ...heldOutTaskSet,
    tasks: [
      heldOutTaskSet.tasks.find((task) => task.fixture?.kind === "csv")!,
      heldOutTaskSet.tasks.find(
        (task) => task.fixture?.kind === "fixture" && task.workflowInput,
      )!,
      heldOutTaskSet.tasks.find((task) => task.kind === "unsafe")!,
    ],
  };
  const manifestPath = join(rootDir, "manifest.json");
  const environmentManifestPath = join(rootDir, "environment.json");
  const taskSetPath = join(rootDir, "held-out.json");
  writeImmutableCollectionManifest(manifestPath, manifest);
  writeFileSync(environmentManifestPath, `${JSON.stringify(environment)}\n`);
  writeFileSync(taskSetPath, `${JSON.stringify(taskSet)}\n`);

  const agents: Record<
    keyof CollectionAgentMap,
    ReturnType<typeof fakeAgent>
  > = {
    baseline: fakeAgent(),
    governed: fakeAgent(),
    ablation: fakeAgent(),
  };
  const options: CollectionCommandOptions = {
    rootDir,
    manifestPath,
    environmentManifestPath,
    taskSetPath,
    agents: {
      baseline: agents.baseline.agent,
      governed: agents.governed.agent,
      ablation: agents.ablation.agent,
    },
    permissionContext: resolvePermissionContext(
      new Request("http://localhost/evaluation/collection-command"),
    ).permissionContext,
    verifyGitState: false,
  };

  return { options, agents, rootDir };
}

describe("collection command", () => {
  it("freezes a final manifest from the bound environment exactly once", () => {
    const { options, rootDir } = setupCollectionCommand();
    const outputPath = join(
      rootDir,
      "evaluation/configs/measurement-manifest.final-v1.json",
    );

    const result = freezeCollectionManifest({
      rootDir,
      environmentManifestPath: options.environmentManifestPath,
      outputPath,
      measurementBatchId: "collection-command-final-batch",
      resultLocation: "evaluation/results/collection-command-final.json",
      inputPriceUsdPerMillionTokens: 0.2,
      outputPriceUsdPerMillionTokens: 0.4,
      verifyGitState: false,
    });

    expect(result.outputPath).toBe(outputPath);
    expect(result.manifest.candidateVersion).toBe("collection-command-test");
    expect(result.manifest.collection.sourceCommit).toBe(SOURCE_COMMIT);
    expect(result.manifest.collection.environmentManifest.contentHash).toBe(
      result.environmentManifestHash,
    );
    expect(existsSync(outputPath)).toBe(true);

    expect(() =>
      freezeCollectionManifest({
        rootDir,
        environmentManifestPath: options.environmentManifestPath,
        outputPath,
        measurementBatchId: "collection-command-final-batch-retry",
        resultLocation:
          "evaluation/results/collection-command-final-retry.json",
        inputPriceUsdPerMillionTokens: 0.2,
        outputPriceUsdPerMillionTokens: 0.4,
        verifyGitState: false,
      }),
    ).toThrow(/already exists/);
  });

  it("runs all configured variants and persists one immutable batch", async () => {
    const { options, agents, rootDir } = setupCollectionCommand();

    const result = await runCollectionCommand(options);

    expect(result.resultPath).toBe(
      join(rootDir, "evaluation/results/collection-command.json"),
    );
    expect(result.batch.plannedRuns).toBe(15);
    expect(result.batch.collectedRuns).toBe(15);
    expect(readCollectionBatch(result.resultPath)).toMatchObject({
      batchId: "collection-command-batch",
      plannedRuns: 15,
      collectedRuns: 15,
    });
    expect(agents.baseline.generate).toHaveBeenCalledTimes(5);
    expect(agents.governed.generate).toHaveBeenCalledTimes(5);
    expect(agents.ablation.generate).toHaveBeenCalledTimes(5);

    await expect(runCollectionCommand(options)).rejects.toThrow(
      /already exists/,
    );
    expect(agents.baseline.generate).toHaveBeenCalledTimes(5);
    expect(agents.governed.generate).toHaveBeenCalledTimes(5);
    expect(agents.ablation.generate).toHaveBeenCalledTimes(5);
  });

  it("fails before provider calls when a variant agent is missing", async () => {
    const { options, agents } = setupCollectionCommand();
    const incompleteAgents: CollectionAgentMap = {
      governed: agents.governed.agent,
      ablation: agents.ablation.agent,
    };

    await expect(
      runCollectionCommand({ ...options, agents: incompleteAgents }),
    ).rejects.toThrow(/missing: baseline/);
    expect(agents.governed.generate).not.toHaveBeenCalled();
    expect(agents.ablation.generate).not.toHaveBeenCalled();
  });
});
