# Data Analysis Agent

An AI-powered data analysis assistant built with [Next.js](https://nextjs.org), [Mastra](https://mastra.ai), and [OpenRouter](https://openrouter.ai). Chat with an agent that can write and execute Python code to analyze data, generate visualizations, and fetch stock market data — all in the browser.

## Features

- **Conversational data analysis** — ask questions in plain English and get back results, charts, and insights.
- **Cloud-sandboxed Python execution** — the agent writes and runs Python 3 in [E2B](https://e2b.dev) cloud sandboxes with pandas, numpy, matplotlib, seaborn, scipy, scikit-learn, and yfinance pre-installed. No local Python required.
- **Auto-generated plots** — matplotlib/seaborn charts are captured and displayed inline.
- **Server-scoped chat memory** — each browser receives a signed server-issued session and resource, with thread cookies cryptographically bound to that scope before Mastra memory is accessed.
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
   SESSION_SIGNING_SECRET=<long_random_server_only_secret>
   ```

The current identity boundary is a server-issued anonymous session for this controlled prototype. A production deployment must replace that bootstrap boundary with an authenticated identity provider while retaining the server-side ownership checks.

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
│   └── api/chat/route.ts     # Chat API route (streams agent responses, signed session/thread isolation)
├── mastra/
│   ├── index.ts              # Mastra configuration (agents, storage, logging)
│   ├── security/             # Server-issued sessions and permission context
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
