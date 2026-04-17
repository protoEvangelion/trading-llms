Always use **Bun**, never `node` or `ts-node`. All scripts run via `bun run <file>`. 
Always run `bun run typecheck` & `bun run test` after making ts(x) file changes. 
Don't overcomplicate unit tests, or add every edge case under the sun. as you discover edge cases, add a test case.

## Bot History

All bots that have been built and backtested are tracked in [bot-log.md](./bot-log.md). Read it before creating a new bot to avoid duplicating a thesis that's already been tried. Update it after every `/create-bot` session.

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
bun --bun run --cwd webapp dev                        # webapp only (port 3000)
bun run runner/src/index.ts                           # runner only (schedules all enabled bots)
```

### Flag Reference

- `--run-now=<botId>`: Triggers a single bot execution immediately and then exits. Useful for testing a bot's current logic or manually forcing a run. Operates in `staging` (paper trading) by default.
- `--init=<botId>`: Performs a special "initialization" run. It uses a 30-day lookback for signals and appends instructions to the system prompt that **force the bot to take a position** (no `do_nothing` allowed). This establishes a starting thesis in the database. Operates in `staging` by default.
- `--backtest=<botId> --start=YYYY-MM-DD --end=YYYY-MM-DD`: Runs a historical simulation between the specified dates. Uses `backtest-runner.ts` and forces the environment to `dev` (simulation DB).
- `--env=[dev|staging|prod]`: Manually override the environment. `dev` uses `data/dev.db`, `staging` uses `data/staging.db`.

### Examples

```bash
bun run runner/src/index.ts --run-now=trump-bot       # force immediate staging run
bun run runner/src/index.ts --init=trump-bot          # initial 30-day thesis run
bun run runner/src/index.ts --backtest=trump-bot --start=2025-01-01 --end=2025-02-01
```

No build step for the runner — Bun runs TypeScript directly.

## Database

SQLite files are located in the `data/` directory (created on first run). The filename depends on `TRADING_ENV`:
- `data/dev.db`: Used for backtests and local development.
- `data/staging.db`: Used for paper trading (default).
- `data/prod.db`: Reserved for live trading with real capital.

Schema is managed inline in `runner/src/db.ts` via `migrate()` — no migration framework. Migrations are `CREATE TABLE IF NOT EXISTS` so they're always safe to re-run.

**Tables:**
- `decisions` — every bot run outcome: action, reasoning, symbol, amount, full tool call trace (JSON)
- `pnl_snapshots` — portfolio value + positions JSON snapshot after every run
- `seen_content` — deduplicate Truth Social posts across runs

All DB writes go through `runner/src/db.ts` helpers. The webapp uses a **read-only** connection in `webapp/src/lib/db.server.ts` — never write from there.

