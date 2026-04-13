# Trading Bots — Claude Instructions

## Runtime

Always use **Bun**, never `node` or `ts-node`. All scripts run via `bun run <file>`.

## Repo Layout

```
runner/src/         Bot execution engine (TypeScript)
  index.ts          Entry point + CLI arg handling
  bots.ts           Bot registry — all bot definitions live here
  bot-runner.ts     Agentic loop (LLM + MCP tool dispatch)
  scheduler.ts      croner-based cron scheduling
  db.ts             SQLite schema, migrations, all DB helpers
  llm.ts            Groq API client (OpenAI-compatible)
  alpaca.ts         Alpaca REST client
  mcp-client.ts     MCP stdio transport + tool dispatch
  mcps/
    truth-social.ts   Playwright scraper for Trump's Truth Social
    web-search.ts     Alpaca News API + DuckDuckGo
    alpaca-trade.ts   Portfolio tools exposed to the LLM

webapp/src/         React observability dashboard (TanStack Start)
  routes/
    index.tsx         Dashboard — bot race chart, summary cards
    bots.$botId.tsx   Bot detail — P&L chart, decision log
  lib/db.server.ts    Read-only SQLite queries for webapp

data/trading.db     SQLite database (WAL mode, not committed)
bots.json           Bot config overrides (not committed — see bots.ts for schema)
.env                API keys (not committed)
design-doc.md       Architecture + known issues + proposed changes
```

## Commands

```bash
bun run dev                            # runner + webapp concurrently
bun run runner/src/index.ts            # runner only (schedules all enabled bots)
bun run runner/src/index.ts --run-now=trump-bot   # force immediate run, then exit
bun run runner/src/index.ts --init=trump-bot      # 30-day lookback init run
bun --bun run --cwd webapp dev         # webapp only (port 3000)
```

No build step for the runner — Bun runs TypeScript directly.

## Database

Single SQLite file at `data/trading.db`. Schema is managed inline in `runner/src/db.ts` via `migrate()` — no migration framework. Migrations are `CREATE TABLE IF NOT EXISTS` so they're always safe to re-run.

**Tables:**
- `decisions` — every bot run outcome: action, reasoning, symbol, amount, full tool call trace (JSON)
- `pnl_snapshots` — portfolio value + positions JSON snapshot after every run
- `position_theses` — LLM's stated reasoning per open position; injected back into prompt each run; upserted on buy, deleted on full sell
- `seen_content` — deduplicate Truth Social posts across runs

All DB writes go through `runner/src/db.ts` helpers. The webapp uses a **read-only** connection in `webapp/src/lib/db.server.ts` — never write from there.

## Adding a New Bot

1. Define the bot in `runner/src/bots.ts` as a `ScheduledBotConfig`
2. Give it a unique `id`, its own Alpaca paper trading credentials (add env var names), and a `system_prompt` that encodes the thesis
3. Add the corresponding env vars to `.env`
4. Set `enabled: true` — the scheduler picks up everything in the exported `bots` array
5. Run `--init=<botId>` first to seed an initial position from a 30-day lookback

## MCP Servers

Each MCP runs as a Bun child process over stdio. `bot-runner.ts` boots them at the start of each run and shuts them down after. Credentials are injected per-run via the `env` field on `McpConfig` — the MCP scripts themselves read generic env var names (`ALPACA_KEY`, etc.), not bot-specific ones.

Do not share state between MCP processes. Each run boots fresh.

## Key Constraints (enforced in code, not just prompts)

- Max 20% of portfolio per position — hard-checked in `alpaca-trade.ts` `buy_stock` before order submission
- Positions are fractional (notional dollar amount, not share count) — Alpaca handles rounding
- `sell_stock` with no `dollar_amount` → `closePosition()` (full exit) → deletes thesis
- `sell_stock` with `dollar_amount` → partial exit → thesis should be updated (currently a bug, see design-doc.md)

## LLM

Groq API, OpenAI-compatible. Config in `runner/src/llm.ts`:
- Temperature: 0.3
- Max tokens: 4096
- Tool choice: `auto`
- Default model: `llama-3.3-70b-versatile` (set per-bot in `bots.ts`)

## Webapp

TanStack Router with file-based routing. Server functions (`createServerFn`) handle DB queries server-side. Never expose raw SQLite to the client.

When adding new data to the bot detail page:
1. Add the query to `webapp/src/lib/db.server.ts`
2. Include it in the `getBotData` server function in `bots.$botId.tsx`
3. Render it in the component

## What Not to Touch

- `data/` — never commit the SQLite file or any trading data
- `.env` — never commit
- `bots.json` — never commit (contains live credentials and live thesis state)
- `node_modules/`, `runner/node_modules/` — bun-managed

## Known Issues

See `design-doc.md` for the full breakdown. Short version:

1. `position_theses` is never shown in the webapp — biggest observability gap
2. Thesis history is destroyed on upsert — no audit trail per position
3. Triggering Truth Social posts are buried in raw tool call JSON in the decision log
4. Partial sells leave `entry_amount` stale in `position_theses`
