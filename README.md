# Data Analysis Agent

An AI-powered data analysis assistant built with [Next.js](https://nextjs.org), [Mastra](https://mastra.ai), and [OpenRouter](https://openrouter.ai). Chat with an agent that can write and execute Python code to analyze data, generate visualizations, and fetch stock market data — all in the browser.

## Features

- **Conversational data analysis** — ask questions in plain English and get back results, charts, and insights.
- **Cloud-sandboxed Python execution** — the agent writes and runs Python 3 in [E2B](https://e2b.dev) cloud sandboxes with pandas, numpy, matplotlib, seaborn, scipy, scikit-learn, and yfinance pre-installed. No local Python required.
- **Auto-generated plots** — matplotlib/seaborn charts are captured and displayed inline.
- **Per-user chat memory** — each user gets a unique thread (via cookie) so conversations persist across page reloads via Mastra memory + PostgreSQL.
- **Vercel-ready** — deploys to Vercel with no extra infrastructure beyond E2B and a PostgreSQL database.

## Prerequisites

- **Node.js** >= 22.13.0
- **pnpm** (recommended) or npm
- An **OpenRouter API key** — get one at [openrouter.ai/keys](https://openrouter.ai/keys)
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
   DATABASE_HOST=<your_supabase_transaction_pooler_host>
   DATABASE_PORT=6543
   DATABASE_USER=<your_supabase_transaction_pooler_user>
   DATABASE_PASSWORD=<your_supabase_database_password>
   ```

3. **Start the dev server**

   ```bash
   pnpm dev
   ```

4. **Open the app**

   Visit [http://localhost:3000](http://localhost:3000) and start chatting. Try a prompt like:

   > Fetch the last 100 days of Apple (AAPL) stock prices and plot a line chart.

## Project Structure

```
src/
├── app/
│   ├── page.tsx              # Chat UI
│   └── api/chat/route.ts     # Chat API route (streams agent responses, per-user threads via cookie)
├── mastra/
│   ├── index.ts              # Mastra configuration (agents, storage, logging)
│   ├── agents/
│   │   └── data-analysis-agent.ts  # Agent definition & system prompt
│   └── tools/
│       └── run-python-code.ts      # Tool that executes Python in E2B cloud sandbox
└── components/               # UI components (conversation, messages, tools, etc.)
```

## Available Scripts

| Command       | Description                    |
| ------------- | ------------------------------ |
| `pnpm dev`    | Start the Next.js dev server   |
| `pnpm build`  | Build for production           |
| `pnpm start`  | Start the production server    |
| `pnpm lint`   | Run ESLint                     |
| `pnpm studio` | Start the Mastra Studio server |

## AI Usage

Mastra and NextJS init processes was used to bootstrap the initial setup and configuration of the repo.

### Milestone Week 1

AI was used to assist with the following tasks:

- **Code generation**: create the `run-python-code` tool
- **Code refactor**: migrate the DB from the file-system based LibSQL to externally hosted Supabase PostGres to work with Vercel deployed app
- **Code generation**: add the example prompts as cards to home page of the app

### Milestone Week 2

AI was used to assist with the following tasks:

- **Code refactor**: migrate `run-python-code` tool from local `python3` execution to [E2B](https://e2b.dev) cloud sandboxes for Vercel compatibility. After initial migration, author discovered that yfinance was not pre-installed in the E2B sandbox, so AI added a `pip install -q yfinance` step that runs in the sandbox before executing user code.
- **Code refactor**: replace module-level shared thread ID with per-user cookie-based thread IDs. Author asked AI whether the existing `randomUUID()` approach would give each Vercel user a unique thread — AI identified that the ID was generated once at module load time and shared across all users/requests, and that it would reset on cold starts. AI then implemented a cookie-based solution using `next/headers`, but this caused a Next.js router initialization error. AI diagnosed the issue and rewrote the approach to parse cookies directly from the request headers instead.
- **Bug fix**: `yfinance` returns DataFrames with MultiIndex columns (even for a single ticker), which caused `Series.__format__` errors when the agent tried to format statistics with f-strings (e.g. `f"{mean_price:.2f}"`). AI diagnosed the root cause and added instructions to the agent's system prompt telling it to flatten MultiIndex columns after download (`df.columns = df.columns.get_level_values(0)`) or convert aggregated values to scalars with `.item()` / `float()` before formatting.
- **Bug fix**: the agent's self-correction loop would repeatedly retry `yfinance` calls on rate-limit errors (`429 Too Many Requests`), burning tokens and compounding the problem. AI added an explicit rule to the agent's system prompt: **never retry on rate-limit errors** — instead, inform the user to try again later. This prevents runaway tool invocations and unnecessary API spend.
