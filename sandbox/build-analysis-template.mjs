// Build the prebuilt E2B sandbox template used by the run-python-code tool.
//
// Usage:
//   E2B_API_KEY=... pnpm sandbox:build
//   E2B_SANDBOX_TEMPLATE=finance-analysis:v2 SANDBOX_PYTHON_PACKAGES="yfinance==0.2.65,tabulate==0.9.0" pnpm sandbox:build
//
// The template extends E2B's stock code-interpreter image, which already ships
// pandas, numpy, matplotlib, seaborn, scipy, and scikit-learn, and adds the
// finance packages the tool previously installed on every run. Pin the package
// versions before the measurement freeze and record the template name in the
// environment manifest.
import { Template } from "@e2b/code-interpreter";

const BASE_TEMPLATE = "code-interpreter-v1";
const templateName =
  process.env.E2B_SANDBOX_TEMPLATE?.trim() || "finance-analysis:v1";
const packages = (process.env.SANDBOX_PYTHON_PACKAGES ?? "yfinance,tabulate")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is required to build the sandbox template.");
  process.exit(1);
}

console.log(
  `Building ${templateName} from ${BASE_TEMPLATE} with ${packages.join(", ")}`,
);
const template = Template().fromTemplate(BASE_TEMPLATE).pipInstall(packages);
const build = await Template.build(template, templateName);
console.log(JSON.stringify(build, null, 2));
console.log(
  `\nSet E2B_SANDBOX_TEMPLATE=${templateName} in .env to use this template.`,
);
