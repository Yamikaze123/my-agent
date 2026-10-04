import { createAzure } from "@ai-sdk/azure";
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

// These are deployment metadata, not secrets. Keep them in source so the only
// Azure value required from the environment is the API key.
const AZURE_RESOURCE_NAME = "cvent-dev2-azure-chatgpt";
const AZURE_DEPLOYMENT_NAME = "gpt-4o";

const azure = createAzure({
  resourceName: AZURE_RESOURCE_NAME,
  apiKey: requiredEnvironmentVariable("AZURE_OPENAI_API_KEY"),
});

export const dataAnalysisAgent = new Agent({
  id: "data-analysis-agent",
  name: "Data Analysis Agent",
  instructions: DATA_ANALYSIS_AGENT_INSTRUCTIONS,
  model: azure.chat(AZURE_DEPLOYMENT_NAME),
  tools: dataAnalysisTools,
  inputProcessors: [
    new ChatInputGuardrailProcessor(),
    new EnsureFinalResponseProcessor(MAX_AGENT_STEPS),
  ],
  outputProcessors: [new ChatOutputGuardrailProcessor()],
  memory,
});
