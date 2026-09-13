import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";

const MAX_MODEL_STDOUT_LENGTH = 8_000;
const MAX_MODEL_STDERR_LENGTH = 4_000;
const SANDBOX_REQUEST_TIMEOUT_MS = 30_000;
const CODE_EXECUTION_TIMEOUT_MS = 45_000;

const INSTALL_ANALYSIS_DEPENDENCIES =
  "import importlib.util, subprocess, sys; " +
  "missing = [p for p in ['yfinance', 'tabulate'] " +
  "if importlib.util.find_spec(p) is None]; " +
  "subprocess.check_call([sys.executable, '-m', 'pip', 'install', " +
  "'--disable-pip-version-check', '--no-input', '--timeout', '15', " +
  "'--retries', '1', '-q', *missing]) if missing else None";

function truncateForModel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  return `${value.slice(0, maxLength)}\n[truncated before being sent to the model]`;
}

function hasEscapedLineBreaks(code: string): boolean {
  return !code.includes("\n") &&
    (code.includes("\\n") || code.includes("\\r\\n"));
}

function decodeEscapedLineBreaks(code: string): string {
  return code.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

function isEscapedLineBreakSyntaxError(
  code: string,
  error: { name: string; value: string } | null | undefined,
): boolean {
  return (
    hasEscapedLineBreaks(code) &&
    error?.name === "SyntaxError" &&
    /line continuation character/i.test(error.value)
  );
}

export const runPythonCodeTool = createTool({
  id: "run-python-code",
  description:
    "Execute Python code in a cloud sandbox and return stdout, stderr, and any generated plot images as base64. " +
    "Use this tool whenever the user asks for data analysis, visualization, statistics, or any computation. " +
    "The code has access to: pandas, numpy, matplotlib, seaborn, yfinance, tabulate, scipy, scikit-learn (sklearn).",
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
  // Keep the complete execution result for the UI, but do not send large
  // base64-encoded images or unbounded logs back through the model context.
  toModelOutput: (output) => ({
    type: "json",
    value: {
      stdout: truncateForModel(output.stdout, MAX_MODEL_STDOUT_LENGTH),
      stderr: truncateForModel(output.stderr, MAX_MODEL_STDERR_LENGTH),
      imageCount: output.images.length,
      success: output.success,
    },
  }),
  execute: async ({ code }) => {
    const sbx = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
      requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
    });

    try {
      const runCode = (source: string) =>
        sbx.runCode(source, {
          timeoutMs: CODE_EXECUTION_TIMEOUT_MS,
          requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
        });

      // Install packages not included in the default E2B sandbox
      const installation = await runCode(INSTALL_ANALYSIS_DEPENDENCIES);
      if (installation.error) {
        return {
          stdout: installation.logs.stdout.join("\n"),
          stderr: `${installation.error.name}: ${installation.error.value}\n${installation.error.traceback}`,
          images: [],
          success: false,
        };
      }

      let execution = await runCode(code);

      // Some provider responses can double-escape a multiline tool argument,
      // leaving literal "\\n" sequences in the Python source. Retry that
      // specific syntax failure after decoding the line breaks. Valid Python
      // that contains escaped newlines is left untouched when it executes
      // successfully on the first attempt.
      if (isEscapedLineBreakSyntaxError(code, execution.error)) {
        execution = await runCode(decodeEscapedLineBreaks(code));
      }

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
