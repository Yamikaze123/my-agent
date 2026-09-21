import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import {
  Observability,
  DefaultExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { dataAnalysisAgent } from "./agents/data-analysis-agent";
import { getFinanceFixtureTool } from "./tools/get-finance-fixture";
import { storage } from "./storage";

export const mastra = new Mastra({
  agents: { dataAnalysisAgent },
  tools: { getFinanceFixtureTool },
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
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
