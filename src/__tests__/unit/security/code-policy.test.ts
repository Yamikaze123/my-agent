import { describe, expect, it } from "vitest";
import {
  CODE_EXECUTION_LIMITS,
  CodePolicyError,
  validatePythonCode,
} from "@/mastra/security/code-policy";

describe("sandbox code policy", () => {
  it("allows bounded finance analysis code", () => {
    expect(
      validatePythonCode(
        "import yfinance as yf\ndf = yf.download('AAPL', period='1mo', progress=False)",
      ),
    ).toContain("yfinance");
  });

  it.each([
    "import subprocess\nsubprocess.run(['id'])",
    "import requests\nrequests.get('https://example.com')",
    "open('/tmp/secrets', 'r').read()",
    "import os\nprint(os.environ['API_KEY'])",
    "eval(user_code)",
    "!pip install an-unapproved-package",
  ])("blocks unsafe code: %s", (code) => {
    expect(() => validatePythonCode(code)).toThrow(CodePolicyError);
  });

  it("enforces a source-size limit", () => {
    expect(() =>
      validatePythonCode("#".repeat(CODE_EXECUTION_LIMITS.maxCodeLength + 1)),
    ).toThrow(/limited/);
  });
});
