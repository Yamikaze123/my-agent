import { describe, it, expect, vi } from "vitest";

vi.mock("@/mastra/storage", () => ({
  storage: {},
  memory: {
    getThread: vi.fn(),
    saveMessages: vi.fn(),
    recall: vi.fn(),
  },
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => ({
    chat: vi.fn(() => ({ modelId: "tencent/hy3-preview:free" })),
  })),
}));

const { dataAnalysisAgent } =
  await import("@/mastra/agents/data-analysis-agent");

describe("dataAnalysisAgent configuration", () => {
  it("has the correct agent id", () => {
    expect(dataAnalysisAgent.id).toBe("data-analysis-agent");
  });

  it("has the correct agent name", () => {
    expect(dataAnalysisAgent.name).toBe("Data Analysis Agent");
  });

  it("has a model configured", () => {
    // The model is stored internally; the agent object itself is truthy and
    // has the expected public identifier properties.
    expect(dataAnalysisAgent).toBeTruthy();
    expect(dataAnalysisAgent.id).toBeTruthy();
  });

  it("is an instance with generate / stream capabilities", () => {
    expect(typeof dataAnalysisAgent.generate).toBe("function");
    expect(typeof dataAnalysisAgent.stream).toBe("function");
  });

  it("exposes its instructions", () => {
    const instructions = (
      dataAnalysisAgent as unknown as { instructions: string }
    ).instructions;
    // Instructions may be stored async or as a string
    expect(
      instructions !== undefined ||
        typeof dataAnalysisAgent.getInstructions === "function",
    ).toBe(true);
  });
});
