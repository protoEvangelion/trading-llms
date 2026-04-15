# Trading Bots

Thesis-driven LLM agent trading framework. Define a thesis, backtest it against historical data, promote to paper trading, then real money. Trump Signal Bot and Data Center Bot are bundled examples.

## Prerequisites

- [Bun](https://bun.sh) >= 1.x
- [Playwright](https://playwright.dev) (for Trump posts scraper)
- Alpaca paper trading account(s) — [alpaca.markets](https://alpaca.markets)
- OpenRouter API key — [openrouter.ai/keys](https://openrouter.ai/keys)

## Setup

```bash
# Install dependencies
bun install
cd runner && bun install && cd ..
cd webapp && bun install && cd ..

# Install Playwright browser (for scraper)
bunx playwright install chromium
```

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

Required vars:
```
OPENROUTER_API_KEY=sk-or-v1-...
ALPACA_TRUMP_BOT_KEY=...
ALPACA_TRUMP_BOT_SECRET=...
ALPACA_TRUMP_BOT_ENDPOINT=https://paper-api.alpaca.markets
```

## Initial Data Setup

Before running trump-bot, seed the Trump posts database (covers the last year):

```bash
bun run scripts/scrape-trump-posts.ts --init
```

This takes ~10–20 minutes (Cloudflare bypass via Playwright). Run once. Future runs use `--update`.

## Running

```bash
# Start runner + webapp together
bun run dev

# Runner only (schedules all enabled bots on their crons)
bun run runner/src/index.ts

# Webapp only (port 3000)
bun --bun run --cwd webapp dev
```

## Bot Commands

```bash
# Force an immediate run (bypasses cron, useful for testing)
bun run runner/src/index.ts --run-now=trump-bot

# Initialization run (30-day lookback, forces a trade)
bun run runner/src/index.ts --init=trump-bot

# Backtest over a date range (writes to data/dev.db)
bun run runner/src/index.ts --backtest=trump-bot --start=2025-04-14 --end=2025-10-14

# Backtest a single day
bun run runner/src/index.ts --backtest=trump-bot --start=2025-04-14 --end=2025-04-15

# Run against paper trading DB explicitly
bun run runner/src/index.ts --env=staging --run-now=trump-bot
```

## Scraper Commands

```bash
# Initial bulk load (last 365 days)
bun run scripts/scrape-trump-posts.ts --init

# Incremental update from last saved post to now
bun run scripts/scrape-trump-posts.ts --update
```

The runner auto-runs `--update` before trump-bot fires each day via `preRunScript`. Manual `--update` is only needed if the runner hasn't been running.

## Adding a New Bot

1. Define a new entry in `runner/src/bots.ts` as a `ScheduledBotConfig`
2. Give it a unique `id`, Alpaca credentials (new env vars), a `model`, and a `system_prompt` that encodes the thesis
3. Add the env vars to `.env`
4. Set `enabled: true` — scheduler picks it up automatically
5. Run `--init=<botId>` for a 30-day lookback seed run
6. Run `--backtest=<botId> --start=... --end=...` to validate the thesis before paper trading

## Environments

| Flag / Env | DB file | Use for |
|---|---|---|
| `--backtest` (auto) | `data/dev.db` | Backtesting |
| `--env=staging` (default) | `data/staging.db` | Paper trading |
| `--env=prod` | `data/prod.db` | Live trading |

## Project Structure

```
runner/src/
  index.ts              CLI entry point + env setup
  bots.ts               Bot registry — all bot definitions here
  bot-runner.ts         Agentic loop (LLM + MCP tool dispatch)
  backtest-runner.ts    Backtest orchestrator (fake clock, sim state)
  scheduler.ts          croner-based cron scheduling + preRunScript
  db.ts                 SQLite schema, migrations, all DB helpers
  llm.ts                OpenRouter client (OpenAI-compatible)
  alpaca.ts             Alpaca REST client
  mcp-client.ts         MCP stdio transport + tool dispatch
  simulation.ts         Sim state I/O, OHLCV helpers, calendar API
  mcps/
    trump-posts.ts      Queries trump_posts table by date range
    web-search.ts       Alpaca News API + DuckDuckGo
    alpaca-trade.ts     Live/paper portfolio tools
    backtest-alpaca-trade.ts  Simulated portfolio tools (backtest only)

scripts/
  scrape-trump-posts.ts Playwright scraper for Truth Social

webapp/src/
  routes/
    index.tsx           Dashboard
    bots.$botId.tsx     Bot detail — P&L, decision log
  lib/db.server.ts      Read-only SQLite queries

data/
  trading.db            Trump posts (shared across envs)
  dev.db                Backtest results
  staging.db            Paper trading records
  prod.db               Live trading records
```
