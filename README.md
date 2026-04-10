# Data Analysis Agent

An AI-powered data analysis assistant built with [Next.js](https://nextjs.org), [Mastra](https://mastra.ai), and [OpenRouter](https://openrouter.ai). Chat with an agent that can write and execute Python code to analyze data, generate visualizations, and fetch stock market data — all in the browser.

## Features

- **Conversational data analysis** — ask questions in plain English and get back results, charts, and insights.
- **Python code execution** — the agent writes and runs Python 3 with pandas, numpy, matplotlib, seaborn, scipy, and yfinance.
- **Auto-generated plots** — matplotlib/seaborn charts are captured and displayed inline.
- **Chat memory** — conversations persist across page reloads via Mastra memory + LibSQL.

## Prerequisites

- **Node.js** >= 22.13.0
- **pnpm** (recommended) or npm
- **Python 3** with the following packages available:
  ```
  pandas numpy matplotlib seaborn yfinance scipy
  ```
  Install them if needed:
  ```bash
  pip3 install pandas numpy matplotlib seaborn yfinance scipy
  ```
- An **OpenRouter API key** — get one at [openrouter.ai/keys](https://openrouter.ai/keys)

## Getting Started

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Configure environment variables**

   Copy the example env file and add your API key:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` (OPENROUTER_API_KEY and DATABASE_PASSWORD are required)

   ```
   OPENROUTER_API_KEY=<your_openrouter_api_key>
   DATABASE_PASSWORD=<your_database_password>
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
│   └── api/chat/route.ts     # Chat API route (streams agent responses)
├── mastra/
│   ├── index.ts              # Mastra configuration (agents, storage, logging)
│   ├── agents/
│   │   └── data-analysis-agent.ts  # Agent definition & system prompt
│   └── tools/
│       └── run-python-code.ts      # Tool that executes Python & captures plots
└── components/               # UI components (conversation, messages, tools, etc.)
```

## Available Scripts

| Command      | Description                  |
| ------------ | ---------------------------- |
| `pnpm dev`   | Start the Next.js dev server |
| `pnpm build` | Build for production         |
| `pnpm start` | Start the production server  |
| `pnpm lint`  | Run ESLint                   |

## AI Usage

Mastra and NextJS init processes was used to bootstrap the initial setup and configuration of the repo. 

AI was used to assist with the following tasks:
- Creating the `run-python-code` tool
- Migrate the DB from the file-system based LibSQL to externally hosted Supabase PostGres to work with Vercel deployed app
- Add the example prompts as cards to home page of the app
