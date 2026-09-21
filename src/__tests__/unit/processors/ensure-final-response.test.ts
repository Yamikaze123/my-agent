import { describe, expect, it } from "vitest";
import { EnsureFinalResponseProcessor } from "@/mastra/processors/ensure-final-response";

describe("EnsureFinalResponseProcessor", () => {
  it("does not change intermediate steps", () => {
    const processor = new EnsureFinalResponseProcessor(5);

    expect(
      processor.processInputStep!({
        stepNumber: 3,
        systemMessages: [],
      } as unknown as Parameters<
        NonNullable<typeof processor.processInputStep>
      >[0]),
    ).toEqual({});
  });

  it("disables tools and requests a summary on the final step", () => {
    const processor = new EnsureFinalResponseProcessor(5);

    expect(
      processor.processInputStep!({
        stepNumber: 4,
        systemMessages: [],
      } as unknown as Parameters<
        NonNullable<typeof processor.processInputStep>
      >[0]),
    ).toEqual({
      tools: {},
      toolChoice: "none",
      systemMessages: [
        {
          role: "system",
          content: expect.stringContaining("Do not call any more tools."),
        },
      ],
    });
  });
});
