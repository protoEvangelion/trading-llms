Always use **Bun**, never `node` or `ts-node`. All scripts run via `bun run <file>`. Always run bun run typecheck after making ts(x) file changes. 

## Repo Layout

```
runner/src/         Bot execution engine (TypeScript)
  index.ts            Entry point + CLI arg handling
  bots.ts             Bot registry — all bot definitions live here
  bot-runner.ts       Agentic loop (LLM + MCP tool dispatch)
  backtest-runner.ts  Backtest orchestrator — iterates trading days, logs PnL
  scheduler.ts        croner-based cron scheduling
  db.ts               SQLite schema, migrations, all DB helpers
  llm.ts              OpenRouter API client (OpenAI-compatible)
  alpaca.ts           Alpaca REST client
  mcp-client.ts       MCP stdio transport + tool dispatch
  simulation.ts       SimState type, Alpaca bar/calendar helpers, cron parsing
  mcps/
    truth-social.ts   Playwright scraper for Trump's Truth Social
    trump-posts.ts    Queries trump_posts table (populated by scripts/scrape-trump-posts.ts)
    web-search.ts     Alpaca News API + DuckDuckGo
    trade.ts          Portfolio tools exposed to the LLM (live)
    backtest-trade.ts Simulated portfolio tools for backtesting

webapp/src/         React observability dashboard (TanStack Start)
  routes/
    __root.tsx        Root layout (html/body, theme init, header/footer)
    index.tsx         Dashboard — bot race chart, summary cards
    bots.$botId.tsx   Bot detail — P&L chart, decision log
    about.tsx         About page
  components/
    Header.tsx        Site header
    Footer.tsx        Site footer
    ThemeToggle.tsx   Light/dark toggle
  lib/db.server.ts    Read-only SQLite queries for webapp
  router.tsx          TanStack Router setup

data/staging.db     SQLite for paper trading (WAL mode, not committed)
data/dev.db         SQLite for backtests (WAL mode, not committed)
bots.json           Bot config overrides (not committed — see bots.ts for schema)
.env                API keys (not committed)
design-doc.md       Architecture + known issues + proposed changes
```

## Commands

```bash
bun run dev                                           # runner + webapp concurrently
bun run runner/src/index.ts                           # runner only (schedules all enabled bots)
bun run runner/src/index.ts --run-now=trump-bot       # force immediate run, then exit
bun run runner/src/index.ts --run-now=datacenter-bot  # force immediate run, then exit
bun run runner/src/index.ts --init=trump-bot          # 30-day lookback init run
bun run runner/src/index.ts --init=datacenter-bot     # init datacenter bot
bun --bun run --cwd webapp dev                        # webapp only (port 3000)
bun run runner/src/index.ts --backtest=trump-bot --start=YYYY-MM-DD --end=YYYY-MM-DD
bun run runner/src/index.ts --backtest=datacenter-bot --start=YYYY-MM-DD --end=YYYY-MM-DD
```

No build step for the runner — Bun runs TypeScript directly.

## Database

Single SQLite file at `data/trading.db`. Schema is managed inline in `runner/src/db.ts` via `migrate()` — no migration framework. Migrations are `CREATE TABLE IF NOT EXISTS` so they're always safe to re-run.

**Tables:**
- `decisions` — every bot run outcome: action, reasoning, symbol, amount, full tool call trace (JSON)
- `pnl_snapshots` — portfolio value + positions JSON snapshot after every run
- `seen_content` — deduplicate Truth Social posts across runs

All DB writes go through `runner/src/db.ts` helpers. The webapp uses a **read-only** connection in `webapp/src/lib/db.server.ts` — never write from there.

