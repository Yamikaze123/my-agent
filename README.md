# Data Analysis Agent

An AI-powered data analysis assistant built with [Next.js](https://nextjs.org), [Mastra](https://mastra.ai), and [OpenRouter](https://openrouter.ai). Chat with an agent that can write and execute Python code to analyze data, generate visualizations, and fetch stock market data — all in the browser.

## Features

- **Conversational data analysis** — ask questions in plain English and get back results, charts, and insights.
- **Cloud-sandboxed Python execution** — the agent writes and runs Python 3 in [E2B](https://e2b.dev) cloud sandboxes with pandas, numpy, matplotlib, seaborn, scipy, scikit-learn, and yfinance pre-installed. No local Python required.
- **Auto-generated plots** — matplotlib/seaborn charts are captured and displayed inline.
- **Server-scoped chat memory** — each browser receives a signed server-issued session and resource, with thread cookies cryptographically bound to that scope before Mastra memory is accessed.
- **Governed finance profile/quality path** — owner-scoped fixture/CSV datasets can be profiled and checked by a registered deterministic Mastra workflow before metric execution.
- **Measurement-ready evaluation harness** — versioned baseline/governed/ablation manifests, held-out finance tasks, deterministic scoring, and an offline schema-valid smoke run.
- **Single-instance deployment** — runs as one Node.js server process with E2B and a PostgreSQL database. Uploaded datasets, the sandbox concurrency cap, and request rate limits are held in process memory (see [Deployment notes](#deployment-notes)), so the app is not yet suited to serverless or multi-instance hosting.

## Prerequisites

- **Node.js** >= 22.13.0
- **pnpm** 8.15.7 or a compatible pnpm 8 release
- An **OpenRouter API key**; the current model is `nvidia/nemotron-3.5-super-vl:free` in `src/mastra/agents/data-analysis-agent.ts`
- An **E2B API key** (free tier, no credit card) — get one at [e2b.dev/dashboard](https://e2b.dev/dashboard?tab=keys)
- A **Supabase PostgreSQL database** — create a project at [supabase.com](https://supabase.com), then go to **Settings > Database** and copy the **Transaction pooler** connection password

## Getting Started

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Configure environment variables**

   Copy the example env file and add your API keys:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env`:

   ```
   OPENROUTER_API_KEY=<your_openrouter_api_key>
   E2B_API_KEY=<your_e2b_api_key>
   E2B_SANDBOX_TEMPLATE=
   DATABASE_HOST=<your_supabase_transaction_pooler_host>
   DATABASE_PORT=6543
   DATABASE_USER=<your_supabase_transaction_pooler_user>
   DATABASE_PASSWORD=<your_supabase_database_password>
   SESSION_SIGNING_SECRET=<long_random_server_only_secret>
   ```

3. **Build the sandbox template (recommended)**

   Without a template the Python tool runs on E2B's stock image and installs
   `yfinance` and `tabulate` on every execution, which adds a PyPI round trip
   and tens of seconds per analysis. Build a template once per E2B account and
   set `E2B_SANDBOX_TEMPLATE=finance-analysis:v1` (or the name you built):

   ```bash
   pnpm sandbox:build
   ```

   Pin package versions before an evaluation freeze with
   `SANDBOX_PYTHON_PACKAGES="yfinance==<ver>,tabulate==<ver>"` and bump the
   template tag. When the template is set, the per-run install step is skipped
   and PyPI is removed from the sandbox network allowlist. Leave the variable
   empty to fall back to the stock image.

The current identity boundary is a server-issued anonymous session for this controlled prototype. A production deployment must replace that bootstrap boundary with an authenticated identity provider while retaining the server-side ownership checks.

4. **Start the dev server**

   ```bash
   pnpm dev
   ```

5. **Open the app**

   Visit [http://localhost:3000](http://localhost:3000) and start chatting. Try a prompt like:

   > Fetch the last 100 days of Apple (AAPL) stock prices and plot a line chart.

## Project Structure

```
src/
├── app/
│   ├── page.tsx              # Chat UI
│   └── api/chat/route.ts     # Chat API route (streams agent responses, signed session/thread isolation)
├── mastra/
│   ├── index.ts              # Mastra configuration (agents, workflow, storage, logging)
│   ├── security/             # Server-issued sessions and permission context
│   ├── datasets/              # Owner-scoped process-local catalog
│   ├── profiling/             # Deterministic profile statistics
│   ├── quality/               # Finance quality rules and findings
│   ├── workflows/             # Registered profile/quality workflow
│   ├── evaluation/            # Evaluation manifests, tasks, runner, and scorer
│   ├── agents/
│   │   └── data-analysis-agent.ts  # Agent definition & system prompt
│   └── tools/
│       └── run-python-code.ts      # Tool that executes Python in E2B cloud sandbox
└── components/               # UI components (conversation, messages, tools, etc.)
```

## Deployment notes

- **Process-local state.** The dataset catalog (`src/mastra/datasets/catalog.ts`), the Python sandbox concurrency counter, and the request rate limiter (`src/mastra/security/rate-limit.ts`) live in the memory of one server process. Datasets are lost on restart and are not visible to other instances; on a serverless or multi-instance host an upload handled by one instance cannot be analyzed by another, and each instance enforces its own limits. Run a single long-lived instance, or move this state to shared storage first. Chat history is the exception: it is stored in PostgreSQL.
- **Request limits.** Every API action is limited per anonymous session and per client address, and issuing new sessions is limited per address, so dropping the cookie does not reset an allowance for free. The client address is read from `X-Forwarded-For`, so deploy behind a proxy that sets it and strips client-supplied values.
- **Identity.** Sessions are anonymous and server-issued. A production deployment needs an authenticated identity provider in front of the same server-side ownership checks.
- **Response headers.** `next.config.ts` sets baseline security headers. A full Content-Security-Policy is not configured yet.

## Available Scripts

| Command           | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `pnpm dev`        | Start the Next.js dev server                                 |
| `pnpm build`      | Build for production                                         |
| `pnpm start`      | Start the production server                                  |
| `pnpm lint`       | Run ESLint                                                   |
| `pnpm studio`     | Start the Mastra Studio server                               |
| `pnpm eval:smoke` | Verify measurement records for all three evaluation variants |
