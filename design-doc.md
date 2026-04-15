# Trading Bots — Design Document

## Overview

A thesis-driven, AI-powered trading framework. The core idea: given any investment thesis, an LLM agent executes that thesis autonomously on a schedule — gathering signals, analyzing positions, and making trades. Multiple theses are raced against each other and against the S&P 500 through a structured promotion pipeline before any real capital is deployed.

Trump Signal Bot and Data Center Infrastructure Bot are **example implementations** of this framework, not the purpose of it.

---

## Thesis Promotion Pipeline

```
You define a thesis
      │
      ▼
┌─────────────────────────────────────────────────────┐
│  BACKTESTING  (dev.db, historical simulation)        │
│  • Same agent, fake clock (SIM_DATE)                 │
│  • Posts/news capped to simDate — no lookahead       │
│  • Fills at historical open price via Alpaca OHLCV   │
│  • 1 tick per trading day (respects bot's cron)      │
│                                                      │
│  Promotion gate:                                     │
│    total return > SPY (same period)                  │
│    AND max drawdown < 30%                            │
│    AND human approval                                │
└──────────────────────┬──────────────────────────────┘
                       │ promoted
                       ▼
┌─────────────────────────────────────────────────────┐
│  PAPER TRADING  (staging.db, Alpaca paper account)   │
│  • Live market data, real signals, no real money     │
│  • Same agent, same prompt, real-time execution      │
│                                                      │
│  Promotion gate:                                     │
│    positive return over 30 days                      │
│    AND return > SPY (same 30-day window)             │
│    AND human approval                                │
└──────────────────────┬──────────────────────────────┘
                       │ promoted
                       ▼
┌─────────────────────────────────────────────────────┐
│  REAL TRADING  (prod.db, Alpaca live account)        │
│  • Real capital, same agent                          │
└─────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                         runner/                           │
│                                                           │
│  index.ts ──► scheduler.ts ──► bot-runner.ts              │
│       │            │                                      │
│       │       backtest-runner.ts                          │
│       │            │                                      │
│       │      SimulationContext                            │
│       │   (fake clock + JSON state file)                  │
│       │            │                                      │
│       ▼       ┌────┴────────┐                             │
│  TRADING_ENV  │             │                             │
│  dev.db       db.ts      alpaca.ts                        │
│  staging.db      │                                        │
│  prod.db         │                                        │
│                  │                                        │
│  ┌───────────────┴──────────┐    MCP servers (stdio)      │
│  │  Core tables (all envs)  │    /        |        \      │
│  │  decisions               │  trump-   web-   alpaca-    │
│  │  pnl_snapshots           │  posts   search   trade     │
│  │  position_reasons        │                             │
│  │  backtest_runs           │                             │
│  └──────────────────────────┘                             │
│                                                           │
│  data/trump_posts → shared trump_posts table              │
│  (scraper writes trading.db; MCP reads trading.db)        │
└───────────────────────────────────────────────────────────┘
                     │ SQLite (WAL, read-only)
┌───────────────────────────────────────────────────────────┐
│                         webapp/                           │
│  TanStack Router + Start (SSR, Vite)                      │
│  routes/index.tsx           ── promotion pipeline Kanban  │
│  routes/backtest.$runId.tsx ── backtest detail + results  │
│  routes/bots.$botId.tsx     ── live/paper bot detail      │
│  lib/db.server.ts           ── read-only SQLite queries   │
└───────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript |
| LLM provider | OpenRouter (`google/gemini-3-flash-preview` default; configurable per bot) |
| LLM client | OpenAI SDK (OpenRouter is OpenAI-compatible) |
| Broker | Alpaca Markets (paper + live) |
| Database | SQLite via `bun:sqlite`, WAL mode |
| MCP servers | Hand-rolled stdio transport (`mcp-client.ts`), one child process per run |
| Frontend | React 19, TanStack Router/Start, Recharts, Tailwind CSS |
| Scheduling | croner (cron expressions, `America/New_York` timezone) |
| Signal scraping | Playwright headless Chromium (Cloudflare bypass for Truth Social) |
| Deployment | Local, Mac mini. LLMs from cloud providers — no local models. |

---

## Database Layout (dev / staging / prod)

Three separate SQLite files, same schema:

| File | Environment | Used for |
|---|---|---|
| `data/dev.db` | `TRADING_ENV=dev` | Backtesting |
| `data/staging.db` | `TRADING_ENV=staging` (default) | Paper trading |
| `data/prod.db` | `TRADING_ENV=prod` | Live trading |

`--backtest` CLI flag automatically sets `TRADING_ENV=dev`. The `--env=` flag overrides explicitly.

`data/trading.db` is a legacy file used only by `trump_posts` (the scraper writes there; the trump-posts MCP reads there). It is not a runner environment DB.

---

## Bot Execution Flow

The same agent runs in all three environments. The only difference is what the tools see.

```
Scheduler fires (or backtest-runner advances clock)
  └─► runBot(bot, backtestCtx?)
        ├─ Build MCP list: inject credentials; swap alpaca-trade → backtest-alpaca-trade if backtest
        ├─ Boot MCP child processes (stdio)
        ├─ Load open position_reasons → inject into prompt
        │    ("You currently hold XLE because: ...")
        ├─ Build user message:
        │    current datetime  ← simDateTime if backtest, real now if live
        │    + anti-lookahead reminder (backtest only)
        │    + position reasons context block
        │    + "check portfolio, gather signals, decide"
        └─ Agentic loop (max 10 iterations):
              LLM call (temp 0.3, max 1024 tokens, brevity directive injected)
                └─ Tool calls dispatched to MCP child processes:
                      get_trump_posts(lookback_days=7)
                           ← queries trump_posts (capped to simDate in backtest)
                      web_search(query)
                           ← Alpaca News API (capped to simDate in backtest)
                      get_portfolio
                           ← sim state file (backtest) | Alpaca API (live)
                      get_recent_orders
                      buy_stock  ──► terminal; fill at open price
                      sell_stock ──► terminal; fill at open price
                      do_nothing ──► terminal
              ↑ repeat until terminal or max iterations
        ├─ upsert/close position_reasons on buy/sell
        └─ logDecision() → decisions table (backtestRunId set for backtest rows)

Backtest only — after each trading day:
  └─ calculatePortfolioValue() → logPnlSnapshot() with backtestRunId + simDate + spyValue
```

### Agentic Loop Constraints

- Max 10 iterations per run
- Temperature 0.3
- Max 1024 output tokens (hard cap — reduces completion cost; agents are instructed to be terse)
- No hard position size limits — agent decides conviction and allocation freely

### Brevity Directive (middleware)

`llm.ts` appends a brevity directive to every system message before the API call — no per-bot configuration needed:

```
RESPONSE STYLE: Be extremely terse. No preamble, no summaries, no explanations of what
you're doing. Think in bullet points. When reasoning, use fragments. Every word costs money.
```

This is injected in `injectBrevity()` inside `callLLM()`, applied universally to all bots.
The `max_tokens` ceiling was reduced from 4096 → 1024 simultaneously. Typical completion
usage is ~200–300 tokens per call; the new ceiling gives 3–4× headroom without allowing runaway prose.

---

## Backtesting

### How It Works

Backtesting uses the **same agent** with a `BacktestContext` injected that controls the fake clock and routes trading tool calls to a simulation MCP.

```typescript
interface BacktestContext {
  simDateTime: string   // "2025-04-14T09:15:00" — agent thinks this is "now"
  stateFilePath: string // JSON file shared between runner and backtest MCP
  backtestRunId: number // foreign key for DB logging
}
```

The state file is a JSON document on disk that the backtest MCP reads/writes on every tool call. It holds cash, positions, and filled orders for the current run.

### Cron Respecting

`getSimDateTimes(day, bot.cron)` parses the bot's cron expression and returns one ISO datetime per scheduled tick on that trading day. With `15 9 * * 1-5`, that's one tick at 9:15 AM — one agent run per trading day. The backtest loop runs exactly as many ticks per day as production would.

### Lookahead Bias Controls

| Layer | What's protected |
|---|---|
| `get_trump_posts` | `posted_at <= simDate` — no future posts |
| `web_search` | Alpaca News API `end=simDate` — no future news |
| `get_portfolio` | sim state file — only sees fills made during the run |
| `buy_stock` / `sell_stock` | fill at simDate open price via Alpaca OHLCV |

**Known limitation:** LLM training weights may contain knowledge of outcomes within the backtest window. The system prompt instructs the agent to trade only on observed signals, not on training-data knowledge. Treat backtest results as optimistic upper bounds; relative performance (thesis vs SPY, thesis A vs thesis B) is more meaningful than absolute returns.

### Fill Price

Trades fill at the **open price of simDate** fetched from Alpaca OHLCV. The agent runs pre-market (9:15 AM ET), decisions are made before the open, and fills are at the opening print. No intraday lookahead.

---

## MCP Servers

Each MCP server runs as a Bun child process over stdio, booted at the start of each run and shut down after. Credentials are injected per-run via the `env` field on `McpConfig`.

### `trump-posts`

Queries `trump_posts` table in `data/trading.db` (read-only). Never scrapes live during an agent run.

- Tool: `get_trump_posts(lookback_days: 1–30)` — default 7
- In backtest mode: `SIM_DATE` env var caps results to `posted_at <= simDate`
- Response size guard: if response exceeds ~4000 tokens, returns an error telling the agent to halve `lookback_days`

### `web-search`

Financial queries → Alpaca News API (`data.alpaca.markets/v1beta1/news`).
General queries → DuckDuckGo Instant Answer API (no-op in backtest mode).

- In backtest mode: `SIM_DATE` env var caps Alpaca News `end` param

### `alpaca-trade` (live/paper)

Real Alpaca API calls. Bot credentials injected per-run.

- Tools: `get_portfolio`, `buy_stock`, `sell_stock`, `do_nothing`, `get_recent_orders`
- No hard position size limits — agent allocates freely

### `backtest-alpaca-trade` (backtest only)

Simulates portfolio via a JSON state file on disk. Uses Alpaca OHLCV historical endpoint for fill prices.

- Swapped in by `bot-runner.ts` when `BacktestContext` is present
- Reads/writes `BACKTEST_STATE_FILE` on every tool call
- No real orders submitted

---

## Data Schema

All tables exist in all three env DBs (dev/staging/prod) with the same schema. `backtest_run_id` and `sim_date` columns on `decisions` and `pnl_snapshots` distinguish backtest rows from live rows.

### `decisions`

Every bot run outcome.

```sql
CREATE TABLE decisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id           TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'live',  -- live | paper | backtest
  timestamp        TEXT NOT NULL,                 -- real wall-clock time of run
  reasoning        TEXT,
  action           TEXT NOT NULL,  -- buy_stock | sell_stock | do_nothing | no_action | error | max_iterations
  symbol           TEXT,
  amount           REAL,
  fill_price       REAL,
  tool_calls       TEXT NOT NULL DEFAULT '[]',  -- JSON: [{tool, args, result}]
  backtest_run_id  INTEGER REFERENCES backtest_runs(id),  -- NULL for live/paper
  sim_date         TEXT                                   -- NULL for live/paper
)
```

### `pnl_snapshots`

End-of-day portfolio value snapshots.

```sql
CREATE TABLE pnl_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id           TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'live',
  timestamp        TEXT NOT NULL,
  portfolio_value  REAL NOT NULL,
  cash             REAL NOT NULL,
  positions        TEXT NOT NULL DEFAULT '{}',
  spy_value        REAL,                                  -- SPY equivalent on same date
  backtest_run_id  INTEGER REFERENCES backtest_runs(id),
  sim_date         TEXT
)
```

### `position_reasons`

LLM's stated reasoning for each open (or historically open) position. Injected back into prompt on every subsequent run so the agent can re-evaluate conviction.

```sql
CREATE TABLE position_reasons (
  bot_id        TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  entered_at    TEXT NOT NULL,
  entry_amount  REAL,
  closed_at     TEXT,           -- NULL = open; set on full exit, never auto-deleted
  PRIMARY KEY (bot_id, symbol)
)
```

Rows are never deleted automatically. `closed_at` is set on full exit. Manual pruning when deprecating a thesis.

### `backtest_runs`

Metadata for each backtest execution.

```sql
CREATE TABLE backtest_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  sim_start     TEXT NOT NULL,
  sim_end       TEXT NOT NULL,
  status        TEXT NOT NULL,   -- running | completed | failed
  total_return  REAL,
  spy_return    REAL,
  max_drawdown  REAL,
  beats_spy     INTEGER          -- 0 | 1
)
```

### `trump_posts`

Scraped Trump Truth Social posts. Lives in `data/trading.db` (written by scraper, read by trump-posts MCP). Not in the env-specific DBs.

```sql
CREATE TABLE trump_posts (
  post_id    TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  posted_at  TEXT NOT NULL,
  is_retruth INTEGER NOT NULL DEFAULT 0,
  scraped_at TEXT NOT NULL
)
-- Index: (posted_at DESC)
```

---

## Bot Registry

Bots are defined in `runner/src/bots.ts`. Each entry is an `ScheduledBotConfig`:

```typescript
interface ScheduledBotConfig extends BotConfig {
  id: string
  name: string
  description?: string
  model: string                // OpenRouter model ID
  system_prompt: string
  alpacaKeyEnv: string         // env var names for this bot's Alpaca credentials
  alpacaSecretEnv: string
  alpacaEndpointEnv: string
  mcps: McpConfig[]
  cron: string                 // 5-field cron, America/New_York
  enabled: boolean
  preRunScript?: string[]      // optional command to run before each scheduled tick
}
```

### Current Bots

**`trump-bot` — Trump Signal Bot**
- Thesis: Trump's Truth Social posts signal policy shifts before mainstream news catches up
- Schedule: `15 9 * * 1-5` (9:15 AM ET, 15 min before market open, weekdays)
- preRunScript: `bun run scripts/scrape-trump-posts.ts --update` (runs fresh before each tick)
- Model: `google/gemini-3-flash-preview`
- MCPs: `trump-posts` + `web-search` + `alpaca-trade`
- Lookback: 7 days of posts (last week), default in MCP

**`datacenter-bot` — Data Center Infrastructure Bot**
- Thesis: AI/cloud demand structurally undersupplies physical data center infrastructure for a decade
- Schedule: `45 3 * * 1-5` (3:45 AM ET pre-open, once daily, weekdays)
- Strategy: long-biased, buy-and-hold; sells only on thesis invalidation
- MCPs: `web-search` + `alpaca-trade` (no Truth Social — not politically driven)

---

## Position Memory

On `buy_stock` → upsert `position_reasons` row with LLM's stated reasoning.
On next run → load all open reasons and inject into system prompt verbatim so the agent can re-evaluate.
On `sell_stock` (full) → set `closed_at` on the reason row.
On `sell_stock` (partial) → update `entry_amount` in reason row.

Reason rows survive process restarts and are never auto-deleted. Manual or CLI-assisted pruning when deprecating a losing thesis.

---

## Signal Freshness (trump-bot)

The `preRunScript` field on trump-bot runs `scrape-trump-posts.ts --update` immediately before the agent fires at 9:15 AM. This ensures the DB contains posts up to minutes before the run.

In backtest mode, the scraper is not involved — all posts are already in `trading.db` and the MCP filters by `simDate`.

---

## Promotion Criteria

| Gate | Requirement |
|---|---|
| Backtest → Paper | Total return > SPY AND max drawdown < 30% AND human approval |
| Paper → Real | Positive return AND return > SPY (30-day window) AND human approval |

Human approval is always required. Metrics surface in the webapp.

---

## Environment Variables

| Var | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | LLM API key (openrouter.ai/keys) |
| `TRADING_ENV` | `dev` / `staging` / `prod` — selects which DB file to open |
| `ALPACA_TRUMP_BOT_KEY` | Alpaca key for trump-bot |
| `ALPACA_TRUMP_BOT_SECRET` | Alpaca secret for trump-bot |
| `ALPACA_TRUMP_BOT_ENDPOINT` | Alpaca endpoint for trump-bot (`https://paper-api.alpaca.markets`) |
| `ALPACA_DATACENTER_BOT_KEY` | Alpaca key for datacenter-bot |
| `ALPACA_DATACENTER_BOT_SECRET` | Alpaca secret for datacenter-bot |
| `ALPACA_DATACENTER_BOT_ENDPOINT` | Alpaca endpoint for datacenter-bot |
| `TRADING_BOTS_DATA_DIR` | Override `data/` directory (defaults to repo root `data/`) |

---

## Known Issues

### 1. position_reasons not shown in webapp
Biggest observability gap. Fix: add `getPositionReasons()` to `db.server.ts`, render "Current Positions" panel on bot detail page.

### 2. Signal attribution buried
Triggering posts are inside raw `tool_calls` JSON in the decision log. Fix: parse `get_trump_posts` results from `tool_calls` and render as a highlighted "Signal" callout.

### 3. Partial sell leaves stale entry_amount
On partial sell, `entry_amount` in `position_reasons` should be decremented. Currently only updated if the existing amount is known at sell time.

### 4. trump_posts lives in trading.db not env DBs
The scraper and trump-posts MCP always use `data/trading.db` directly, independent of `TRADING_ENV`. This is intentional (trump posts are global data, not per-environment trading records) but cosmetically inconsistent.

---

## Proposed Next Phases

### Phase 1 — Mastra.ai Migration
Replace hand-rolled `bot-runner.ts` + `mcp-client.ts` agentic loop with Mastra.ai. Use their native MCP client and `TokenLimiterProcessor` for context overflow protection.

### Phase 2 — Webapp Promotion Pipeline
- Kanban at `/`: thesis cards with mode badge, return %, vs SPY, drawdown
- Backtest detail at `/backtest/$runId`: P&L chart vs SPY, decision log with sim date
- Bot detail improvements: current positions panel, signal attribution

### Phase 3 — Observability Fixes
- Surface `position_reasons` in webapp (issue 1)
- Signal attribution in decision log (issue 2)
- Fix partial sell `entry_amount` (issue 3)

### Phase 4 — Options Trading
Prerequisite: equity strategy beats SPY consistently over 3+ months in paper trading.
When ready: add `buy_option(symbol, expiry, strike, side, contracts, reason)` to the trade MCP. Start with directional calls/puts only (no spreads), 30–45 DTE, on ETFs already in the universe.
