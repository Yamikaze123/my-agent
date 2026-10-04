import { getFinanceFixtureTool } from "./get-finance-fixture";
import { listFinanceDatasetsTool } from "./list-finance-datasets";
import { runPythonCodeTool } from "./run-python-code";
import { runFinanceAnalysisTool } from "./run-finance-analysis";

export const dataAnalysisTools = {
  runPythonCodeTool,
  getFinanceFixtureTool,
  listFinanceDatasetsTool,
  runFinanceAnalysisTool,
} as const;

// Mastra tool calls can use either the registered object key or the tool's
// public ID depending on the adapter. Keep both names derived from the same
// registry used by the agent so a newly registered tool cannot be silently
// rejected by the output guardrail.
export const CHAT_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(dataAnalysisTools).flatMap(([name, tool]) => [name, tool.id]),
);
