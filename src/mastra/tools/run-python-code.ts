import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ALL_TRAFFIC, Sandbox } from "@e2b/code-interpreter";
import { redactSensitiveText } from "../security/chat-policy";
import { requirePermission } from "../security/permission-context";
import {
  APPROVED_OUTBOUND_HOSTS,
  CODE_EXECUTION_LIMITS,
  CodePolicyError,
  truncateExecutionOutput,
  validatePythonCode,
} from "../security/code-policy";

const MAX_MODEL_STDOUT_LENGTH = 8_000;
const MAX_MODEL_STDERR_LENGTH = 4_000;
const SANDBOX_REQUEST_TIMEOUT_MS = CODE_EXECUTION_LIMITS.requestTimeoutMs;
const CODE_EXECUTION_TIMEOUT_MS = CODE_EXECUTION_LIMITS.executionTimeoutMs;

let activeExecutions = 0;

const INSTALL_ANALYSIS_DEPENDENCIES =
  "import importlib.util, subprocess, sys; " +
  "missing = [p for p in ['yfinance', 'tabulate'] " +
  "if importlib.util.find_spec(p) is None]; " +
  "subprocess.check_call([sys.executable, '-m', 'pip', 'install', " +
  "'--disable-pip-version-check', '--no-input', '--index-url', " +
  "'https://pypi.org/simple', '--timeout', '15', " +
  "'--retries', '1', '-q', *missing]) if missing else None";

function truncateForModel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  return `${value.slice(0, maxLength)}\n[truncated before being sent to the model]`;
}

function safeExecutionText(value: string, maxLength: number): string {
  return truncateExecutionOutput(redactSensitiveText(value), maxLength);
}

function executionErrorText(
  error: { name: string; value: string; traceback: string } | null | undefined,
): string {
  if (!error) return "";
  return `${error.name}: ${error.value}\n${error.traceback}`;
}

function failedResult(stderr: string): {
  stdout: string;
  stderr: string;
  images: string[];
  success: false;
} {
  return {
    stdout: "",
    stderr: safeExecutionText(stderr, CODE_EXECUTION_LIMITS.maxStderrLength),
    images: [],
    success: false,
  };
}

function hasEscapedLineBreaks(code: string): boolean {
  return (
    !code.includes("\n") && (code.includes("\\n") || code.includes("\\r\\n"))
  );
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
    "The code has access to: pandas, numpy, matplotlib, seaborn, yfinance, tabulate, scipy, scikit-learn (sklearn). " +
    "For single-ticker yfinance data, prefer Ticker.history, select the Close column, and ensure the result is a one-dimensional pandas Series before calling pd.to_numeric. Never pass a DataFrame to pd.to_numeric. If history is empty, use yf.download as a fallback and select the requested ticker column after selecting Close.",
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
  execute: async ({ code }, context) => {
    requirePermission(context?.requestContext, "run:execute");

    let validatedCode: string;
    try {
      validatedCode = validatePythonCode(code);
    } catch (error) {
      if (error instanceof CodePolicyError) {
        return failedResult(error.message);
      }
      throw error;
    }

    if (activeExecutions >= CODE_EXECUTION_LIMITS.maxConcurrentExecutions) {
      return failedResult(
        "The code execution concurrency limit has been reached. Please retry shortly.",
      );
    }

    activeExecutions += 1;
    type CodeSandbox = Awaited<ReturnType<typeof Sandbox.create>> & {
      runCode: (
        source: string,
        options: {
          timeoutMs: number;
          requestTimeoutMs: number;
        },
      ) => Promise<{
        logs: { stdout: string[]; stderr: string[] };
        results: Array<{ png?: string }>;
        error: { name: string; value: string; traceback: string } | null;
      }>;
    };

    let sbx: CodeSandbox;
    try {
      sbx = (await Sandbox.create({
        apiKey: process.env.E2B_API_KEY,
        requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
        network: {
          allowOut: [...APPROVED_OUTBOUND_HOSTS],
          denyOut: [ALL_TRAFFIC],
          allowPublicTraffic: false,
        },
      })) as CodeSandbox;
    } catch (error) {
      activeExecutions -= 1;
      throw error;
    }

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
          stdout: safeExecutionText(
            installation.logs.stdout.join("\n"),
            CODE_EXECUTION_LIMITS.maxStdoutLength,
          ),
          stderr: safeExecutionText(
            executionErrorText(installation.error),
            CODE_EXECUTION_LIMITS.maxStderrLength,
          ),
          images: [],
          success: false,
        };
      }

      let execution = await runCode(validatedCode);

      // Some provider responses can double-escape a multiline tool argument,
      // leaving literal "\\n" sequences in the Python source. Retry that
      // specific syntax failure after decoding the line breaks. Valid Python
      // that contains escaped newlines is left untouched when it executes
      // successfully on the first attempt.
      if (isEscapedLineBreakSyntaxError(validatedCode, execution.error)) {
        execution = await runCode(decodeEscapedLineBreaks(validatedCode));
      }

      const stdout = safeExecutionText(
        execution.logs.stdout.join("\n"),
        CODE_EXECUTION_LIMITS.maxStdoutLength,
      );
      const stderr = safeExecutionText(
        execution.logs.stderr.join("\n"),
        CODE_EXECUTION_LIMITS.maxStderrLength,
      );

      // Collect base64-encoded PNG images from execution results
      const images: string[] = [];
      for (const result of execution.results) {
        if (result.png) {
          if (images.length >= CODE_EXECUTION_LIMITS.maxImages) {
            return failedResult(
              `The sandbox returned more than ${CODE_EXECUTION_LIMITS.maxImages} images.`,
            );
          }
          if (result.png.length > CODE_EXECUTION_LIMITS.maxImageLength) {
            return failedResult(
              `A generated image exceeded the ${CODE_EXECUTION_LIMITS.maxImageLength.toLocaleString()} character limit.`,
            );
          }
          images.push(result.png);
        }
      }

      const success = !execution.error;

      return {
        stdout,
        stderr: execution.error
          ? safeExecutionText(
              executionErrorText(execution.error),
              CODE_EXECUTION_LIMITS.maxStderrLength,
            )
          : stderr,
        images,
        success,
      };
    } catch (err) {
      return failedResult(err instanceof Error ? err.message : String(err));
    } finally {
      await sbx.kill().catch(() => {});
      activeExecutions -= 1;
    }
  },
});
