import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { writeFile, readFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const TIMEOUT_MS = 60_000;

export const runPythonCodeTool = createTool({
  id: "run-python-code",
  description:
    "Execute Python code and return stdout, stderr, and any generated plot images as base64. " +
    "Use this tool whenever the user asks for data analysis, visualization, statistics, or any computation. " +
    "The code has access to: pandas, numpy, matplotlib, seaborn, yfinance, scipy.",
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
    const workDir = join(tmpdir(), `pyexec-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });

    const plotDir = join(workDir, "plots");
    await mkdir(plotDir, { recursive: true });

    // Prepend setup code that configures matplotlib for non-interactive use
    // and auto-saves any figures
    const wrappedCode = `
import sys, os
os.environ['MPLBACKEND'] = 'Agg'
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

_plot_dir = ${JSON.stringify(plotDir)}
_plot_counter = [0]

_original_show = plt.show
def _patched_show(*args, **kwargs):
    for fig_num in plt.get_fignums():
        fig = plt.figure(fig_num)
        path = os.path.join(_plot_dir, f"plot_{_plot_counter[0]}.png")
        fig.savefig(path, dpi=150, bbox_inches='tight')
        _plot_counter[0] += 1
    plt.close('all')
plt.show = _patched_show

# User code below
${code}

# Auto-save any remaining open figures
if plt.get_fignums():
    plt.show()
`;

    const scriptPath = join(workDir, "script.py");
    await writeFile(scriptPath, wrappedCode, "utf-8");

    try {
      const { stdout, stderr } = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        execFile(
          "python3",
          [scriptPath],
          {
            timeout: TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            cwd: workDir,
            env: { ...process.env, MPLBACKEND: "Agg" },
          },
          (error, stdout, stderr) => {
            if (error && (error as { killed?: boolean }).killed) {
              reject(
                new Error(`Execution timed out after ${TIMEOUT_MS / 1000}s`),
              );
            } else {
              // Resolve even on non-zero exit (so we can return stderr)
              resolve({ stdout: stdout || "", stderr: stderr || "" });
            }
          },
        );
      });

      // Collect generated images
      const images: string[] = [];
      try {
        const { readdirSync } = await import("fs");
        const files = readdirSync(plotDir)
          .filter((f: string) => f.endsWith(".png"))
          .sort();
        for (const file of files) {
          const imgBuf = await readFile(join(plotDir, file));
          images.push(imgBuf.toString("base64"));
        }
      } catch {
        // No plots generated
      }

      const success = !stderr || !stderr.includes("Traceback");

      return { stdout, stderr, images, success };
    } catch (err) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        images: [],
        success: false,
      };
    } finally {
      // Clean up
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});
