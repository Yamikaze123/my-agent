import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCode = vi.fn();
const mockKill = vi.fn().mockResolvedValue(undefined);
const mockCreate = vi.fn();

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: { create: mockCreate },
}));

const { runPythonCodeTool } = await import("@/mastra/tools/run-python-code");

type ToolOutput = {
  stdout: string;
  stderr: string;
  images: string[];
  success: boolean;
};

async function execute(code: string): Promise<ToolOutput> {
  const result = await runPythonCodeTool.execute!({ code }, {});
  return result as ToolOutput;
}

function makeExecution(opts: {
  stdout?: string[];
  stderr?: string[];
  pngs?: string[];
  error?: { name: string; value: string; traceback: string } | null;
}) {
  return {
    logs: {
      stdout: opts.stdout ?? [],
      stderr: opts.stderr ?? [],
    },
    results: (opts.pngs ?? []).map((png) => ({ png })),
    error: opts.error ?? null,
  };
}

function setupSandbox(execution: ReturnType<typeof makeExecution>) {
  mockRunCode
    .mockResolvedValueOnce(undefined) // pip install yfinance
    .mockResolvedValueOnce(execution); // actual code
  mockCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runPythonCodeTool", () => {
  describe("successful execution", () => {
    it("returns stdout from code output", async () => {
      setupSandbox(makeExecution({ stdout: ["hello world"] }));

      const result = await execute('print("hello world")');

      expect(result.success).toBe(true);
      expect(result.stdout).toBe("hello world");
      expect(result.stderr).toBe("");
      expect(result.images).toEqual([]);
    });

    it("joins multiple stdout lines with newline", async () => {
      setupSandbox(makeExecution({ stdout: ["line 1", "line 2", "line 3"] }));

      const result = await execute("print(1); print(2); print(3)");

      expect(result.stdout).toBe("line 1\nline 2\nline 3");
    });

    it("extracts PNG images from execution results", async () => {
      const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
      setupSandbox(makeExecution({ pngs: [b64] }));

      const result = await execute("import matplotlib; plt.show()");

      expect(result.images).toEqual([b64]);
    });

    it("extracts multiple PNG images", async () => {
      setupSandbox(makeExecution({ pngs: ["img1", "img2"] }));

      const result = await execute("...");

      expect(result.images).toHaveLength(2);
    });

    it("always installs yfinance before running user code", async () => {
      setupSandbox(makeExecution({}));

      await execute("import yfinance");

      expect(mockRunCode).toHaveBeenCalledTimes(2);
      expect(mockRunCode.mock.calls[0][0]).toMatch(/pip.*install.*yfinance/);
    });
  });

  describe("execution errors", () => {
    it("sets success=false when execution has an error", async () => {
      setupSandbox(
        makeExecution({
          error: {
            name: "NameError",
            value: "name 'x' is not defined",
            traceback: "Traceback (most recent call last):\n  ...",
          },
        }),
      );

      const result = await execute("print(x)");

      expect(result.success).toBe(false);
    });

    it("formats stderr from execution error fields", async () => {
      const error = {
        name: "ZeroDivisionError",
        value: "division by zero",
        traceback: "Traceback...",
      };
      setupSandbox(makeExecution({ error }));

      const result = await execute("1/0");

      expect(result.stderr).toContain("ZeroDivisionError");
      expect(result.stderr).toContain("division by zero");
      expect(result.stderr).toContain("Traceback...");
    });

    it("returns empty images on error", async () => {
      setupSandbox(
        makeExecution({
          error: { name: "RuntimeError", value: "fail", traceback: "" },
        }),
      );

      const result = await execute("raise RuntimeError()");

      expect(result.images).toEqual([]);
    });
  });

  describe("sandbox lifecycle", () => {
    it("kills the sandbox after successful execution", async () => {
      setupSandbox(makeExecution({ stdout: ["ok"] }));

      await execute("print('ok')");

      expect(mockKill).toHaveBeenCalledOnce();
    });

    it("kills the sandbox even when runCode throws", async () => {
      mockRunCode.mockRejectedValueOnce(new Error("Sandbox crashed"));
      mockCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });

      const result = await execute("...");

      expect(mockKill).toHaveBeenCalledOnce();
      expect(result.success).toBe(false);
    });

    it("propagates an uncaught error when Sandbox.create fails", async () => {
      // Sandbox.create is outside the try/catch in the tool, so creation
      // failures are not silently caught — they throw to the caller.
      mockCreate.mockRejectedValueOnce(new Error("No API key"));

      await expect(execute("...")).rejects.toThrow("No API key");
    });

    it("propagates a non-Error rejection from Sandbox.create", async () => {
      mockCreate.mockRejectedValueOnce("string error");

      await expect(execute("...")).rejects.toBe("string error");
    });
  });

  describe("schema", () => {
    it("has required tool metadata", () => {
      expect(runPythonCodeTool.id).toBe("run-python-code");
      expect(runPythonCodeTool.description).toBeTruthy();
    });
  });
});
