import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import {
  Observability,
  DefaultExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { dataAnalysisAgent } from "./agents/data-analysis-agent";
import {
  evaluationAgentsEnabled,
  getCollectionAgents,
} from "./evaluation/agents";
import { ToolPayloadCompactor } from "./observability/tool-payload-compactor";
import { dataAnalysisTools } from "./tools/chat-tools";
import { financeAnalysisAblationWorkflow } from "./workflows/finance-analysis-ablation";
import { financeAnalysisWorkflow } from "./workflows/finance-analysis";
import { storage } from "./storage";

// The collection agents exist to measure variants, including a baseline with
// the Python tool and no guardrail processors. They are registered (and so
// served and shown in Studio) only when EVALUATION_AGENTS_ENABLED is "true"
// or "1". NODE_ENV is not used for this: `mastra dev` runs its server with
// NODE_ENV=production. The collection harness imports the agents directly
// and works with the flag unset.
function evaluationAgents(): Record<string, Agent> {
  if (!evaluationAgentsEnabled()) return {};
  const { baseline, governed, ablation } = getCollectionAgents();
  return {
    collectionBaselineAgent: baseline,
    collectionGovernedAgent: governed,
    collectionAblationAgent: ablation,
  };
}

export const mastra = new Mastra({
  agents: {
    dataAnalysisAgent,
    ...evaluationAgents(),
  },
  workflows: { financeAnalysisWorkflow, financeAnalysisAblationWorkflow },
  tools: dataAnalysisTools,
  storage,
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra",
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
        ],
        spanOutputProcessors: [
          // Drop base64 image bytes and cap long text before spans are
          // persisted; tool outputs can otherwise carry megabytes per call.
          new ToolPayloadCompactor(),
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
