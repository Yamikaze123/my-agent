import type {
  ProcessInputStepArgs,
  ProcessInputStepResult,
  Processor,
} from "@mastra/core/processors";

export class EnsureFinalResponseProcessor implements Processor {
  readonly id = "ensure-final-response";

  constructor(private readonly maxSteps: number) {}

  processInputStep({
    stepNumber,
    systemMessages,
  }: ProcessInputStepArgs): ProcessInputStepResult {
    if (stepNumber !== this.maxSteps - 1) return {};

    return {
      tools: {},
      toolChoice: "none",
      systemMessages: [
        ...systemMessages,
        {
          role: "system",
          content:
            "You have reached the maximum number of steps. Summarize the validated results already available and provide a best-effort response. If the task is incomplete, clearly state what remains unresolved. Do not call any more tools.",
        },
      ],
    };
  }
}
