# Pre-capstone baseline report

Baseline ID: pre-capstone-2026-09-13

Status: technical snapshot captured; deterministic verification reproduced;
provider-backed behavioral evidence remains explicitly bounded.

## Source state

- Baseline Git tag: `pre-capstone-baseline-2026-09-13-latest`
- Tagged application commit:
  `70000881a6dee5f572547283716af69970f71008`
- Commit date: 2026-09-13T09:24:18-04:00
- Commit message: feat: establish current application baseline
- Earlier observed snapshot commit before the rebased baseline tag:
  `9901766b0bcffd0705f80d238893c1f47b381018`

## Current application

The baseline contains:

- One data-analysis-agent.
- One typed run-python-code tool using an E2B sandbox.
- A Next.js chat route with cookie-based thread persistence.
- PostgreSQL-backed Mastra memory.
- A conversational UI that renders text, tool output, and plots.
- Finance analysis through yfinance.

Current runtime configuration:

- Azure OpenAI deployment: gpt-4o.
- Azure resource name: cvent-dev2-azure-chatgpt.
- Memory resource ID: data-analysis-chat.
- Maximum agent steps: 3.
- Maximum completion tokens: 1,200.
- Model retries: 0.
- Memory history: 8 messages.
- E2B request timeout: 30 seconds.
- Python execution timeout: 45 seconds.

## Environment

- Node: 22.19.0
- npm: 10.9.3
- pnpm: 8.15.7
- Next.js: 16.2.3
- Mastra core: 1.24.1
- Mastra AI SDK: 1.3.3
- Mastra memory: 1.15.0
- Mastra PostgreSQL: 1.9.0
- E2B code interpreter: 2.4.0
- AI SDK: 6.0.154
- Vitest: 4.1.10
- package.json SHA-256:
  2785e41d34ecdadee4ea1430b560c673b9ace90d6dec3306b884501936a558df
- pnpm-lock.yaml SHA-256:
  42696314949089fc93b17c883d91e9b084e4618dbc88f89e09aee75ea9529bb8

Only record whether credentials are present. Never record their values or
commit the .env file.

## Verification results

Captured on 2026-09-13:

| Command               | Result                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| npm test              | Passed: 5 test files and 54 tests                                                       |
| npm run test:coverage | Passed with warning: 77.04% statements, 55.88% branches, 86.95% functions, 79.82% lines |
| npm run lint          | Exit 0 with one warning from generated coverage/block-navigation.js                     |
| npm run build         | Passed: production build and TypeScript checks completed                                |

The coverage command reported a parse warning for the ignored
src/mastra/.DS_Store file. The build reported that Mastra Cloud observability
was disabled because MASTRA_CLOUD_ACCESS_TOKEN was not set.

Repeat the checks from a clean checkout with:

```bash
pnpm install --frozen-lockfile
npm test
npm run test:coverage
npm run lint
npm run build
```

## Verification supplement — 2026-11-01

The tagged source was extracted into an isolated temporary checkout and
installed from its own lockfile with Node 22.19.0 and pnpm 8.15.7. The
candidate working tree was not used as source code for these checks.

| Command                          | Result                                                                      |
| -------------------------------- | --------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed; the tagged lockfile resolved 1,340 packages.                        |
| `pnpm test`                      | Passed: 5 test files and 54 tests.                                          |
| `pnpm test:coverage`             | Passed: 77.04% statements, 55.88% branches, 86.95% functions, 79.82% lines. |
| `pnpm lint`                      | Passed with exit 0.                                                         |
| `pnpm exec tsc --noEmit`         | Passed with exit 0.                                                         |
| `pnpm exec next build --webpack` | Exit 0; warnings documented below.                                          |

The production build emitted the known E2B bundling warning for a dynamic
`require` in `vscode-languageserver-types`, reported that Mastra Cloud
observability was disabled because `MASTRA_CLOUD_ACCESS_TOKEN` was absent,
and could not resolve the configured PostgreSQL service while initializing and
creating `mastra_threads`. The build still completed and produced the expected
static and dynamic routes, but live PostgreSQL-backed memory was not verified
in this environment.

## Behavioral evidence boundary

The tagged baseline agent is wired to the documented Azure OpenAI deployment
and reads `AZURE_OPENAI_API_KEY`. That credential was not present in the local
verification environment. The tagged `.env.example` instead lists an
`OPENROUTER_API_KEY`, which does not match the agent implementation. No new
provider-backed baseline conversation was therefore claimed from the clean
checkout.

The existing screenshots remain observational evidence only. The committed
`prompt2.2.png` supports a reviewed text response, and the chart screenshots
support the chart observations. The invalid-ticker error response and a manual
new-chat/thread reset are not present in the committed evidence. These gaps are
recorded rather than inferred from the deterministic tests.

## Known limitations

- Live yfinance data is not reproducible and may be rate-limited.
- No fixture or replay connector exists yet.
- Dataset ingestion, structured profiling, quality reports, deterministic
  transformations, validation, lineage, and domain packs are not implemented.
- The chat route uses one constant resource ID and does not provide
  authenticated tenant isolation.
- Thread IDs come from a client cookie and are not bound to an identity.
- The Python tool has timeouts but no complete memory, concurrency,
  image-size, or sandbox network policy.
- Dependencies such as yfinance and tabulate are installed at request time.
- The UI receives base64 plot images, although image bytes are removed from
  the model-facing tool result.
- Complete run IDs, fixture versions, token usage, cost, and lineage are not
  yet persisted for every analysis.
- No live browser, E2B, PostgreSQL-memory, or provider-backed behavioral run
  has been archived yet.
- The tagged source has a provider configuration mismatch: the agent uses
  Azure OpenAI while the example environment file names an OpenRouter key.
- The local verification environment could not resolve the configured
  PostgreSQL service, so memory-backed runtime behavior remains unverified.

## Completion checklist

- [x] Source commit and included documentation are reviewed.
- [x] Verification commands pass or their warnings are documented.
- [ ] Each prompt in PROMPTS.md has been run and recorded in RESULTS.md.
- [ ] At least one chart, one text-only response, and one error case have
      been reviewed; the chart and text-only portions are confirmed, but the
      error response is not present in the committed evidence.
- [x] No secrets or private data are present in the evidence.
- [x] The pre-capstone baseline commit is tagged as
      `pre-capstone-baseline-2026-09-13-latest`.
