import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";

export const runPythonCodeTool = createTool({
  id: "run-python-code",
  description:
    "Execute Python code in a cloud sandbox and return stdout, stderr, and any generated plot images as base64. " +
    "Use this tool whenever the user asks for data analysis, visualization, statistics, or any computation. " +
    "The code has access to: pandas, numpy, matplotlib, seaborn, yfinance, scipy, scikit-learn (sklearn).",
  inputSchema: z.object({
    code: z
      .string()
      .describe("The Python code to execute. Must be valid Python 3."),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    images: z.array(z.string()).describe("Base64-encoded PNG images"),
    success: z.boolean(),
  }),
  execute: async ({ code }) => {
    const sbx = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
    });

    try {
      // Install packages not included in the default E2B sandbox
      await sbx.runCode(
        "import subprocess; subprocess.check_call(['pip', 'install', '-q', 'yfinance'])",
      );

      const execution = await sbx.runCode(code);

      const stdout = execution.logs.stdout.join("\n");
      const stderr = execution.logs.stderr.join("\n");

      // Collect base64-encoded PNG images from execution results
      const images: string[] = [];
      for (const result of execution.results) {
        if (result.png) {
          images.push(result.png);
        }
      }

      const success = !execution.error;

      return {
        stdout,
        stderr: execution.error
          ? `${execution.error.name}: ${execution.error.value}\n${execution.error.traceback}`
          : stderr,
        images,
        success,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        images: [],
        success: false,
      };
    } finally {
      await sbx.kill().catch(() => {});
    }
  },
});
