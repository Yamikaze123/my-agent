import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { Agent } from "@mastra/core/agent";
import { memory } from "../storage";
import { MAX_AGENT_STEPS, requiredEnvironmentVariable } from "../config";
import { EnsureFinalResponseProcessor } from "../processors/ensure-final-response";
import {
  ChatInputGuardrailProcessor,
  ChatOutputGuardrailProcessor,
} from "../processors/chat-guardrails";
import { dataAnalysisTools } from "../tools/chat-tools";
import { DATA_ANALYSIS_AGENT_INSTRUCTIONS } from "./prompt-blocks";

// The model ID is non-secret; the API key is read from the server-only
// environment variable so it is never exposed to the browser.

const openRouterProvider = createOpenRouter({
  apiKey: requiredEnvironmentVariable("OPENROUTER_API_KEY"),
  baseURL: "https://openrouter.ai/api/v1",
  compatibility: "strict",
});

export const dataAnalysisAgent = new Agent({
  id: "data-analysis-agent",
  name: "Data Analysis Agent",
  instructions: DATA_ANALYSIS_AGENT_INSTRUCTIONS,
  model: openRouterProvider.chat("nvidia/nemotron-3.5-super-vl:free"),
  tools: dataAnalysisTools,
  inputProcessors: [
    new ChatInputGuardrailProcessor(),
    new EnsureFinalResponseProcessor(MAX_AGENT_STEPS),
  ],
  outputProcessors: [new ChatOutputGuardrailProcessor()],
  memory,
});
