import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCode = vi.fn();
const mockKill = vi.fn().mockResolvedValue(undefined);
const mockCreate = vi.fn();

vi.mock("@e2b/code-interpreter", () => ({
  ALL_TRAFFIC: "0.0.0.0/0",
  Sandbox: { create: mockCreate },
}));

const { runPythonCodeTool } = await import("@/mastra/tools/run-python-code");
const { createMastraRequestContext, resolvePermissionContext } =
  await import("@/mastra/security/permission-context");

type ToolOutput = {
  stdout: string;
  stderr: string;
  images: string[];
  success: boolean;
};

async function execute(code: string): Promise<ToolOutput> {
  const permissionContext = resolvePermissionContext(
    new Request("http://localhost/api/chat"),
  ).permissionContext;
  const result = await runPythonCodeTool.execute!(
    { code },
    { requestContext: createMastraRequestContext(permissionContext) },
  );
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
    .mockResolvedValueOnce(makeExecution({})) // dependency check/install
    .mockResolvedValueOnce(execution); // actual code
  mockCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runPythonCodeTool", () => {
  it("fails closed without a validated RequestContext", async () => {
    await expect(
      runPythonCodeTool.execute!({ code: "print('blocked')" }, {}),
    ).rejects.toThrow(/Unauthorized/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("blocks unsafe code before creating a sandbox", async () => {
    const result = await execute("import subprocess\nsubprocess.run(['id'])");

    expect(result.success).toBe(false);
    expect(result.stderr).toContain("blocked");
    expect(mockCreate).not.toHaveBeenCalled();
  });

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

    it("keeps image data out of the model-facing tool output", () => {
      const modelOutput = runPythonCodeTool.toModelOutput?.({
        stdout: "summary",
        stderr: "",
        images: ["very-large-base64-image"],
        success: true,
      });

      expect(modelOutput).toEqual({
        type: "json",
        value: {
          stdout: "summary",
          stderr: "",
          imageCount: 1,
          success: true,
        },
      });
    });

    it("truncates unbounded logs in the model-facing tool output", () => {
      const modelOutput = runPythonCodeTool.toModelOutput?.({
        stdout: "x".repeat(8_001),
        stderr: "y".repeat(4_001),
        images: [],
        success: false,
      }) as {
        value: { stdout: string; stderr: string };
      };

      expect(modelOutput.value.stdout).toHaveLength(8_000 + 43);
      expect(modelOutput.value.stderr).toHaveLength(4_000 + 43);
      expect(modelOutput.value.stdout).toContain("[truncated");
      expect(modelOutput.value.stderr).toContain("[truncated");
    });

    it("always installs analysis dependencies before running user code", async () => {
      setupSandbox(makeExecution({}));

      await execute("import yfinance");

      expect(mockRunCode).toHaveBeenCalledTimes(2);
      expect(mockRunCode.mock.calls[0][0]).toContain("yfinance");
      expect(mockRunCode.mock.calls[0][0]).toContain("tabulate");
      expect(mockRunCode.mock.calls[0][1]).toEqual({
        timeoutMs: 45_000,
        requestTimeoutMs: 30_000,
      });
      expect(mockRunCode.mock.calls[1][1]).toEqual({
        timeoutMs: 45_000,
        requestTimeoutMs: 30_000,
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          network: expect.objectContaining({
            allowPublicTraffic: false,
            allowOut: expect.arrayContaining([
              "query1.finance.yahoo.com",
              "pypi.org",
              "files.pythonhosted.org",
            ]),
            denyOut: ["0.0.0.0/0"],
          }),
        }),
      );
    });

    it("returns an installation error without running user code", async () => {
      mockRunCode.mockResolvedValueOnce(
        makeExecution({
          error: {
            name: "TimeoutError",
            value: "dependency installation timed out",
            traceback: "",
          },
        }),
      );
      mockCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });

      const result = await execute("import yfinance");

      expect(result.success).toBe(false);
      expect(result.stderr).toContain("dependency installation timed out");
      expect(mockRunCode).toHaveBeenCalledOnce();
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

    it("recovers from provider-escaped multiline Python source", async () => {
      mockRunCode
        .mockResolvedValueOnce(makeExecution({}))
        .mockResolvedValueOnce(
          makeExecution({
            error: {
              name: "SyntaxError",
              value: "unexpected character after line continuation character",
              traceback: "Traceback...",
            },
          }),
        )
        .mockResolvedValueOnce(makeExecution({ stdout: ["recovered"] }));
      mockCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });

      const escapedCode = "import pandas as pd\\nprint('recovered')";
      const result = await execute(escapedCode);

      expect(result.success).toBe(true);
      expect(result.stdout).toBe("recovered");
      expect(mockRunCode).toHaveBeenCalledTimes(3);
      expect(mockRunCode.mock.calls[2][0]).toBe(
        "import pandas as pd\nprint('recovered')",
      );
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
      expect(runPythonCodeTool.description).toContain(
        "Never pass a DataFrame to pd.to_numeric",
      );
    });
  });
});
