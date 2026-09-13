# Pre-capstone baseline report

Baseline ID: pre-capstone-2026-09-13

Status: technical snapshot captured; behavioral results pending.

## Source state

- Observed application commit:
  9901766b0bcffd0705f80d238893c1f47b381018
- Commit date: 2026-09-12
- Commit message: feat: redesign data studio and harden analysis execution
- Candidate Git tag: not created
- Working-tree items requiring a decision before tagging:
  - README.md has an uncommitted change.
  - doc/DATA_PLATFORM_EXPANSION_PLAN.md is untracked.
  - doc/THESIS_PROJECT_DESCRIPTION.md is untracked.

A tag points to a commit, not to uncommitted files. Decide whether these
documentation changes belong in the baseline, then commit the intended files
before tagging.

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

## Completion checklist

- [ ] Source commit and included documentation are reviewed.
- [ ] Verification commands pass or their warnings are documented.
- [ ] Each prompt in PROMPTS.md has been run and recorded in RESULTS.md.
- [ ] At least one chart, one text-only response, and one error case have
      been reviewed.
- [ ] No secrets or private data are present in the evidence.
- [ ] The approved commit is tagged as the capstone baseline.
