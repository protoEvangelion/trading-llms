# Trading Bots — Design Document

## Overview

A thesis-driven, AI-powered paper trading framework. An LLM continuously monitors Trump's Truth Social posts, maps them to market sector signals, executes trades via Alpaca, and logs reasoning for every decision. A React webapp provides real-time visibility into performance.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        runner/                          │
│                                                         │
│  index.ts ──► scheduler.ts ──► bot-runner.ts            │
│                                    │                    │
│                         ┌──────────┼──────────┐         │
│                         ▼          ▼          ▼         │
│                      llm.ts   alpaca.ts    db.ts         │
│                         │                    │          │
│                   mcp-client.ts         trading.db       │
│                    /    |    \                           │
│          truth-social  web   alpaca-trade                │
│                       -search                           │
└─────────────────────────────────────────────────────────┘
                              │ SQLite (WAL, read-only)
┌─────────────────────────────────────────────────────────┐
│                        webapp/                          │
│                                                         │
│  TanStack Router + Start (SSR, Vite)                    │
│  routes/index.tsx      ── dashboard, bot race chart     │
│  routes/bots.$botId.tsx ── per-bot P&L, decision log    │
│  lib/db.server.ts      ── read-only SQLite queries      │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript |
| LLM | Groq (`llama-3.3-70b-versatile`) via OpenAI-compatible API |
| Tool integration | Model Context Protocol (MCP), stdio transport |
| Broker | Alpaca Markets (paper trading) |
| Database | SQLite via `bun:sqlite`, WAL mode |
| Frontend | React 19, TanStack Router/Start, Recharts, Tailwind CSS |
| Scheduling | croner (cron expressions, `America/New_York` timezone) |
| Signal scraping | Playwright headless Chromium (Truth Social, Cloudflare bypass) |

---

## Bot Execution Flow

```
Scheduler fires (cron)
  └─► runBot(bot)
        ├─ Boot MCP clients (3 child processes via stdio)
        ├─ Load active position theses from DB
        ├─ Build initial prompt:
        │    system_prompt + current datetime + thesis context
        │    + "check portfolio, then gather signals"
        └─ Agentic loop (max 10 iterations):
              LLM call
                ├─ No tool calls → finalAction = "no_action", break
                └─ Tool calls dispatched to MCP servers:
                      get_truth_social_posts
                      web_search
                      get_portfolio
                      get_recent_orders
                      buy_stock  ──► terminal, upsert thesis, break
                      sell_stock ──► terminal, (delete thesis if full exit), break
                      do_nothing ──► terminal, break
              ↑ repeat until terminal or max iterations
        ├─ logDecision() → decisions table
        ├─ logPnlSnapshot() → pnl_snapshots table
        └─ Shutdown MCP clients
```

### Agentic Loop Constraints

- Max 10 iterations per run
- Temperature 0.3 (deterministic)
- Max 4096 output tokens
- Max 5 open positions (soft, enforced via system prompt)
- Max 20% portfolio per position (hard, enforced by `buy_stock` tool pre-flight)

---

## Bot Registry

Bots are declared in `bots.json` (not committed; loaded at runtime). Each bot has:

```typescript
interface BotConfig {
  id: string
  name: string
  description?: string
  model: string
  system_prompt: string
  alpacaKeyEnv: string       // env var name for this bot's Alpaca key
  alpacaSecretEnv: string
  alpacaEndpointEnv: string
  mcps: McpConfig[]
  cron: string               // standard 5-field cron, ET timezone
}
```

### Current Bots

**`trump-bot` — Trump Signal Bot**
- Thesis: Trump's Truth Social posts signal policy shifts that move market sectors before mainstream news catches up
- Schedule: `0 */4 * * 1-5` (every 4 hours, weekdays)
- Alpaca account: paper trading, separate credentials per bot
- Signal → sector mappings (hardcoded in system prompt):

| Signal | Tickers |
|---|---|
| Iran tensions / military | USO, XLE, XOM, CVX, LMT, RTX, NOC |
| China tariffs | domestic manufacturers ↑, importers ↓ |
| Crypto / bitcoin support | MSTR, COIN, IBIT |
| "Drill baby drill" / energy | XLE, XOM, HAL |
| Fed criticism / rate cuts | GLD, REIT ETFs |
| Healthcare attacks | sell pharma |
| Infrastructure / made in USA | X, NUE, XLI |
| Palantir / war-tech praise | PLTR |
| Immigration crackdown | GEO, CXW |

---

## MCP Servers

Each MCP server runs as a child process with stdio transport. Credentials are injected per-run by `bot-runner.ts`.

### `truth-social`
- Fetches Trump's posts via Playwright headless Chromium
- Bypasses Cloudflare bot detection
- Account ID cached in memory; posts deduplicated via `seen_content` table
- Tool: `get_truth_social_posts(lookback_hours, max_posts)`

### `web-search`
- Financial queries → Alpaca News API (`data.alpaca.markets/v1beta1/news`)
- General queries → DuckDuckGo Instant Answer API (no key required)
- Keyword → ticker mapping for news queries (e.g. "Iran oil" → USO, XLE, XOM, CVX)
- Tool: `web_search(query, use_financial_news)`

### `alpaca-trade`
- Reads generic `ALPACA_KEY` / `ALPACA_SECRET` / `ALPACA_ENDPOINT` env vars
- Tools: `get_portfolio`, `buy_stock`, `sell_stock`, `do_nothing`, `get_recent_orders`
- `buy_stock` enforces 20% position limit before submitting order
- `sell_stock` with no `dollar_amount` → `closePosition()` (full exit)

---

## Database Schema

SQLite at `data/trading.db`. WAL mode enabled. Migrations run inline in `getDb()`.

### `decisions`
Logs every bot run, including runs where no trade was made.

```sql
CREATE TABLE decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  reasoning  TEXT,                        -- LLM's explanation
  action     TEXT NOT NULL,               -- buy_stock | sell_stock | do_nothing | no_action | error | max_iterations
  symbol     TEXT,
  amount     REAL,
  tool_calls TEXT NOT NULL DEFAULT '[]'   -- JSON: [{tool, args, result}]
)
```

Index: `(bot_id, timestamp DESC)`

### `pnl_snapshots`
Point-in-time portfolio snapshots taken after every bot run.

```sql
CREATE TABLE pnl_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id          TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  portfolio_value REAL NOT NULL,
  cash            REAL NOT NULL,
  positions       TEXT NOT NULL DEFAULT '{}'  -- JSON: raw Alpaca positions array
)
```

Index: `(bot_id, timestamp DESC)`

### `position_theses`
The LLM's stated reasoning for each currently open position. Injected back into context on subsequent runs so the LLM can evaluate whether its original conviction still holds.

```sql
CREATE TABLE position_theses (
  bot_id       TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  thesis       TEXT NOT NULL,
  entered_at   TEXT NOT NULL,
  entry_amount REAL,
  PRIMARY KEY (bot_id, symbol)
)
```

### `seen_content`
Prevents the Truth Social MCP from reprocessing posts already acted on.

```sql
CREATE TABLE seen_content (
  bot_id     TEXT NOT NULL,
  content_id TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  PRIMARY KEY (bot_id, content_id)
)
```

---

## Webapp

Read-only SQLite access via `lib/db.server.ts` (TanStack Start server functions). Frontend never writes to the DB.

### Routes

| Route | Purpose |
|---|---|
| `/` | Dashboard: bot race chart (portfolio return %), bot summary cards |
| `/bots/$botId` | Bot detail: stats, P&L chart, system prompt, decision log |

### Bot Detail Page — Current State

- **4 stat cards**: Portfolio Value, Cash, Total Return %, Total Decisions
- **P&L chart**: portfolio value over time (Recharts LineChart)
- **System prompt panel**: raw system prompt + model + cron
- **Decision log**: expandable rows showing action badge, symbol, amount, timestamp, reasoning, raw tool calls

### What the Webapp Does NOT Show

- Current open positions (even though `pnl_snapshots.positions` stores this as JSON)
- Position theses (the `position_theses` table is never queried by the webapp)
- Which specific Truth Social post triggered a given trade (buried in raw tool call JSON)
- Historical evolution of conviction for a position across multiple runs

---

## Known Issues & Gaps

### 1. Position Observability — `position_theses` is Invisible to Humans

**Problem:** The `position_theses` table is the most important piece of signal in the system — it's the LLM's stated reason for holding each position. It's correctly written to on buy and read back on subsequent runs, but the webapp never queries it. A human operator has no way to see current positions alongside their theses without querying SQLite directly.

**Impact:** Cannot answer "why does this bot hold XLE right now?" from the webapp.

**Fix:** Add `getPositionTheses()` to `db.server.ts`, parse `pnl_snapshots.positions` for live market values, render a "Current Positions" panel on the bot detail page showing symbol, thesis, entry date, entry amount, current market value, and unrealized P&L.

---

### 2. Thesis History is Destroyed on Update

**Problem:** `upsertPositionThesis` uses `ON CONFLICT DO UPDATE SET` — it overwrites the previous thesis entirely. If the LLM adds to a position and updates its reasoning, the original entry thesis is gone. There is no record of how conviction evolved.

**Impact:** Cannot audit whether the LLM's reasoning drifted, improved, or contradicted itself over the life of a position.

**Fix:** Add a `position_thesis_history` table that appends a row on every thesis write, with an `event_type` column (`entered` | `reaffirmed` | `scaled_in` | `scaled_out` | `exited`). The current `position_theses` table remains the live/canonical record; history is append-only.

```sql
CREATE TABLE position_thesis_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  thesis      TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_type  TEXT NOT NULL
)
```

---

### 3. Signal Attribution is Buried

**Problem:** The triggering Truth Social post(s) are captured in `decisions.tool_calls` as part of the `get_truth_social_posts` tool result, but the webapp renders this as raw text under a collapsed "Tool calls (N)" accordion. There's no way to quickly see "this buy was triggered by this specific post."

**Impact:** Decision log is hard to audit. You have to expand every row and read raw JSON to understand what caused an action.

**Fix:** Parse `tool_calls` in the webapp to extract `get_truth_social_posts` results and display the triggering post(s) as a highlighted "Signal" block at the top of each decision detail — above the reasoning text. Badge it clearly so the signal-to-action chain is scannable without expanding anything.

---

### 4. Partial Sell Leaves Stale `entry_amount`

**Problem:** In `bot-runner.ts`, `deletePositionThesis` only fires when `isSellAll === true`. When `sell_stock` is called with a `dollar_amount` (partial exit), the thesis record's `entry_amount` is never updated. After scaling out 50% of a position, the thesis still shows the original full entry amount.

**Impact:** The LLM is fed stale context about position sizing on subsequent runs. `entry_amount` shown in any future observability UI will also be wrong.

**Fix:** On partial sell, call `upsertPositionThesis` with the updated `entry_amount` (original minus sold amount) rather than leaving it unchanged. On full sell, the existing `deletePositionThesis` call is correct.

---

## Proposed Changes

### Phase 1 — Surface existing data (no schema changes)

**Goal:** Make `position_theses` and current positions visible in the webapp.

**Changes:**
- `webapp/src/lib/db.server.ts` — add `getPositionTheses(botId)` query and `PositionThesis` interface
- `webapp/src/routes/bots.$botId.tsx` — add "Current Positions" panel:
  - Join theses with latest `pnl_snapshots.positions` JSON on symbol
  - Show: Symbol | Thesis | Entered | Entry $ | Market Value | Unrealized P&L
  - Thesis renders inline (not collapsed)
- `webapp/src/routes/bots.$botId.tsx` — improve decision log signal attribution:
  - Parse `tool_calls` for `get_truth_social_posts` entries
  - Render matching post content as a "Signal" callout block per decision

**Scope:** webapp only, read-only, zero runner changes, zero schema changes.

---

### Phase 2 — Correctness fix (runner only)

**Goal:** Fix the partial sell thesis staleness bug.

**Changes:**
- `runner/src/bot-runner.ts` — on `sell_stock` with `dollar_amount` set, compute and upsert updated `entry_amount` into `position_theses`

**Scope:** runner only, no webapp or schema changes.

---

### Phase 3 — Thesis history (schema + runner + webapp)

**Goal:** Append-only history of how conviction evolves per position.

**Changes:**
- `runner/src/db.ts` — add `position_thesis_history` table to migration; add `appendThesisHistory()` helper
- `runner/src/bot-runner.ts` — call `appendThesisHistory()` on every thesis write with appropriate `event_type`
- `webapp/src/lib/db.server.ts` — add `getThesisHistory(botId, symbol)` query
- `webapp/src/routes/bots.$botId.tsx` — add "Conviction Timeline" accordion within the Current Positions panel, showing the chronological thesis history per symbol

**Scope:** all three layers, additive schema change (new table, no existing table modifications).

---

## Environment & Configuration

| Env Var | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq LLM API key (shared across all bots) |
| `ALPACA_TRUMP_BOT_KEY` | Alpaca API key for trump-bot |
| `ALPACA_TRUMP_BOT_SECRET` | Alpaca API secret for trump-bot |
| `ALPACA_TRUMP_BOT_ENDPOINT` | Alpaca endpoint URL for trump-bot (paper: `https://paper-api.alpaca.markets`) |
| `TRADING_BOTS_DATA_DIR` | Override SQLite directory (defaults to `data/`) |

---

## Running Locally

```bash
# Start runner (schedules all enabled bots)
bun run runner/src/index.ts

# Force a bot run immediately (bypasses cron)
bun run runner/src/index.ts --run-now=trump-bot

# Initialization run (30-day lookback, forces a trade)
bun run runner/src/index.ts --init=trump-bot

# Start webapp on port 3000
bun run webapp

# Start both concurrently
bun run dev
```
