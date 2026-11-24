import { Agent, type AgentConfig } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { MockLanguageModelV3 } from "ai/test";

/**
 * A real Mastra Agent driven by a scripted in-process model. Unlike a
 * hand-written `{ generate }` double, the agent runs Mastra's actual loop, so
 * the step counts, `onStepFinish` calls, tripwires, and tool results the
 * harness reads have the shapes the installed @mastra/core produces. No
 * network or provider is involved.
 */

const STEP_USAGE = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

export const MOCK_STEP_INPUT_TOKENS = 11;
export const MOCK_STEP_OUTPUT_TOKENS = 7;

export type ScriptedModelStep =
  | { text: string }
  | { toolName: string; input: unknown }
  | { error: unknown };

function modelResponse(step: ScriptedModelStep, index: number) {
  if ("error" in step) throw step.error;
  if ("text" in step) {
    return {
      content: [{ type: "text", text: step.text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: STEP_USAGE,
      warnings: [],
    };
  }
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `scripted-call-${index}`,
        toolName: step.toolName,
        input: JSON.stringify(step.input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: STEP_USAGE,
    warnings: [],
  };
}

/** A connection reset shaped the way undici reports it to the AI SDK. */
export function connectionResetError(message = "fetch failed"): Error {
  return Object.assign(new TypeError(message), {
    cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
  });
}

export function scriptedAgent(
  script: readonly ScriptedModelStep[],
  config: Partial<
    Pick<
      AgentConfig,
      "tools" | "workflows" | "inputProcessors" | "outputProcessors"
    >
  > = {},
): { agent: Agent; modelCalls: () => number } {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const index = calls;
      calls += 1;
      const step = script[Math.min(index, script.length - 1)];
      return modelResponse(step, index) as never;
    },
  });
  const agent = new Agent({
    id: "scripted-evaluation-agent",
    name: "Scripted evaluation agent",
    instructions: "Scripted test agent.",
    model: model as never,
    ...config,
  });
  agent.__setLogger(noopLogger);
  return { agent, modelCalls: () => calls };
}
