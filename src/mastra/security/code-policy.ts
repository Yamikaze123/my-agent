export const CODE_EXECUTION_LIMITS = {
  maxCodeLength: 32_000,
  maxStdoutLength: 64_000,
  maxStderrLength: 32_000,
  maxImages: 4,
  maxImageLength: 2_000_000,
  maxConcurrentExecutions: 2,
  executionTimeoutMs: 45_000,
  requestTimeoutMs: 30_000,
} as const;

export const APPROVED_OUTBOUND_HOSTS = [
  // Package bootstrap hosts. The install command is server-controlled and
  // limited to the small analysis dependency allowlist.
  "pypi.org",
  "pypi.python.org",
  "files.pythonhosted.org",
  // Live finance connector hosts.
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "finance.yahoo.com",
  "fc.yahoo.com",
  "guce.yahoo.com",
  "consent.yahoo.com",
] as const;

export class CodePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodePolicyError";
  }
}

const FORBIDDEN_CODE_PATTERNS: readonly RegExp[] = [
  /\b(?:subprocess|socket|requests|httpx|ftplib|paramiko)\b/i,
  /\b(?:urllib|http\.client)\b/i,
  /\b(?:shutil|pathlib|importlib|ctypes|pickle)\b/i,
  /\b(?:import|from)\s+os\b|\bos\.(?:system|popen|remove|unlink|rmdir|rename|replace|chmod|chown|environ|getenv|listdir|walk|scandir|path)\b/i,
  /\b(?:open|eval|exec|compile|__import__)\s*\(/i,
  /\b(?:read_csv|read_excel|read_json|read_pickle|read_parquet|to_csv|to_excel|to_pickle|to_json|savefig)\s*\(/i,
  /(?:^|\n)\s*(?:!|%%)\s*(?:pip|python|bash|sh|curl|wget)\b/i,
  /\b(?:pip|conda)\s+install\b/i,
];

export function validatePythonCode(code: unknown): string {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new CodePolicyError("Python code is required.");
  }
  if (code.length > CODE_EXECUTION_LIMITS.maxCodeLength) {
    throw new CodePolicyError(
      `Python code is limited to ${CODE_EXECUTION_LIMITS.maxCodeLength.toLocaleString()} characters.`,
    );
  }
  if (code.includes("\u0000")) {
    throw new CodePolicyError(
      "Python code contains an invalid control character.",
    );
  }

  const forbiddenPattern = FORBIDDEN_CODE_PATTERNS.find((pattern) =>
    pattern.test(code),
  );
  if (forbiddenPattern) {
    throw new CodePolicyError(
      "That code uses a blocked shell, filesystem, dynamic-execution, or network capability. Use the approved yfinance connector for market data.",
    );
  }

  return code;
}

export function truncateExecutionOutput(
  value: string,
  maxLength: number,
): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[output truncated by the sandbox policy]`;
}
