import { describe, expect, it, vi } from "vitest";

vi.stubEnv("OPENROUTER_API_KEY", "test-api-key");

const { collectionAgents } = await import("@/mastra/evaluation/agents");

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
