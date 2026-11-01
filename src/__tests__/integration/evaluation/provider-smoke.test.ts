import { describe, expect, it } from "vitest";
import {
  environmentManifest,
  heldOutTaskSet,
} from "@/mastra/evaluation/runner";
import {
  createCollectionManifest,
  sha256Content,
} from "@/mastra/evaluation/collection";
import { runMastraProviderSmoke } from "@/mastra/evaluation/provider-runner";

const shouldRun = process.env.RUN_PROVIDER_SMOKE === "1";

describe.skipIf(!shouldRun)("provider collection smoke", () => {
  it("runs one deterministic held-out task through all three variants", async () => {
    const task = heldOutTaskSet.tasks.find(
      (candidate) => candidate.taskId === "metric-v1-total-aapl",
    );
    if (!task) throw new Error("The provider smoke task is missing.");

    const manifest = createCollectionManifest({
      measurementBatchId: "provider-smoke-2026-11-01",
      candidateVersion: environmentManifest.candidateVersion,
      sourceCommit: environmentManifest.sourceCommit,
      environmentManifest,
      environmentManifestHash: sha256Content(
        JSON.stringify(environmentManifest),
      ),
      resultLocation: "evaluation/results/provider-smoke.json",
      inputPriceUsdPerMillionTokens: 0,
      outputPriceUsdPerMillionTokens: 0,
    });
    const { collectionAgents } = await import("@/mastra/evaluation/agents");

    const records = await runMastraProviderSmoke({
      manifest,
      task,
      agents: collectionAgents,
    });

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.variant)).toEqual([
      "baseline",
      "governed",
      "ablation",
    ]);
    expect(
      records.every((record) => record.providerOutcome === "completed"),
    ).toBe(true);
  }, 180_000);
});
