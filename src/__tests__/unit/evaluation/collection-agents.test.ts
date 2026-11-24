import { describe, expect, it, vi } from "vitest";

vi.stubEnv("OPENROUTER_API_KEY", "test-api-key");

const { COLLECTION_MODEL, evaluationAgentsEnabled, getCollectionAgents } =
  await import("@/mastra/evaluation/agents");
const { measurementManifest } = await import("@/mastra/evaluation/runner");
const collectionAgents = getCollectionAgents();

describe("collection agents", () => {
  it("exposes one distinct agent for each frozen variant", () => {
    expect(Object.keys(collectionAgents)).toEqual([
      "baseline",
      "governed",
      "ablation",
    ]);
    expect(collectionAgents.baseline.id).toBe("collection-baseline-agent");
    expect(collectionAgents.governed.id).toBe("collection-governed-agent");
    expect(collectionAgents.ablation.id).toBe("collection-ablation-agent");
    expect(
      new Set(Object.values(collectionAgents).map((agent) => agent.id)),
    ).toHaveLength(3);
  });

  it("builds the agents once and runs the model named by the manifest", async () => {
    expect(getCollectionAgents()).toBe(collectionAgents);
    expect(measurementManifest.model.model).toBe(COLLECTION_MODEL);
    for (const agent of Object.values(collectionAgents)) {
      expect((await agent.getModel()).modelId).toBe(COLLECTION_MODEL);
    }
  });

  it("registers evaluation agents only behind an explicit flag", () => {
    expect(evaluationAgentsEnabled({})).toBe(false);
    expect(evaluationAgentsEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(
      evaluationAgentsEnabled({ EVALUATION_AGENTS_ENABLED: "false" }),
    ).toBe(false);
    expect(evaluationAgentsEnabled({ EVALUATION_AGENTS_ENABLED: "true" })).toBe(
      true,
    );
    expect(evaluationAgentsEnabled({ EVALUATION_AGENTS_ENABLED: "1" })).toBe(
      true,
    );
  });

  it("keeps baseline instructions separate from governed workflow instructions", async () => {
    const baseline = await collectionAgents.baseline.getInstructions();
    const governed = await collectionAgents.governed.getInstructions();
    const ablation = await collectionAgents.ablation.getInstructions();

    expect(baseline).toContain("frozen pre-capstone finance-analysis baseline");
    expect(baseline).toContain("get-collection-fixture");
    expect(governed).toContain("financeAnalysisWorkflow");
    expect(ablation).toContain("financeAnalysisAblationWorkflow");
    expect(ablation).toContain("quality gate is intentionally removed");
  });
});
