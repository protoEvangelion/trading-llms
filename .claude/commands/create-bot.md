# Create & Validate a New Thesis Bot

Autonomously create a new thesis-driven trading bot and progressively validate it through 3 backtest stages. Do NOT ask for help — make all decisions yourself.

## Stage Ladder

```
Stage 1: 7-day backtest   → beats SPY? → Stage 2
Stage 2: 1-month backtest → beats SPY? → Stage 3
Stage 3: 1-year backtest  → beats SPY? → DONE ✅
```

Each stage: max **3 cycles**. Each cycle: run backtest → **validate DB** → analyze → tweak prompt → retry.
If 3 cycles fail a stage: **STOP** and write the final report anyway.
**Validation is mandatory every cycle** — never advance a stage or count a cycle as complete until the DB checks pass.

---

## Step 1 — Invent a Thesis

Design a bot that is **completely different** from the three existing bots:
- `trump-bot` — trades Trump Truth Social posts
- `datacenter-bot` — long data center infrastructure secular thesis
- `claude-bot` — macro regime rotation (TQQQ/QQQ vs SH based on VIX + SPY trend)

Good thesis ideas (pick one or invent your own):
- **Earnings momentum** — buy stocks with recent earnings beats, short misses
- **Options flow** — trade direction implied by unusual options activity (via web search)
- **Sector rotation** — rotate between XLF/XLE/XLK/XLV based on macro signal
- **Small cap momentum** — IWM/TNA when Russell diverges from S&P
- **Credit spread canary** — HYG/JNK spread as risk-on/off signal; rotate into TLT or equities
- **Dollar carry** — UUP (dollar ETF) inverse correlation with commodities/EM
- **Volatility crush** — trade around VIX term structure; buy SVXY after vol spikes

Keep the thesis **mechanistic and signal-driven** — not opinion. The bot needs observable data it can pull via `web_search` and `get_market_snapshot`.

---

## Step 2 — Create the Bot File

### File location
`runner/src/bots/<bot-id>.ts`

### Template
```typescript
import type { ScheduledBotConfig } from "../bots.js"
import { webSearchMcp, alpacaTradeMcp } from "./mcps.js"

export const myBot: ScheduledBotConfig = {
  id: "<bot-id>",          // kebab-case, unique
  name: "<Human Name>",
  description: "<one-line thesis>",
  enabled: false,          // keep false — backtest only, not live scheduled

  cron: "30 9 * * 1-5",   // 9:30 AM ET weekdays

  model: "google/gemini-3-flash-preview",

  alpacaKeyEnv: "ALPACA_TRUMP_BOT_KEY",
  alpacaSecretEnv: "ALPACA_TRUMP_BOT_SECRET",
  alpacaEndpointEnv: "ALPACA_TRUMP_BOT_ENDPOINT",

  system_prompt: `...`,

  mcps: [webSearchMcp, alpacaTradeMcp],
}
```

### System prompt guidelines
- State the thesis clearly upfront
- List exact tools the bot should call and in what order
- Define entry/exit rules as concrete conditions, not vibes
- Specify position sizing (% of $100k portfolio)
- Define what "do_nothing" means for this strategy (patience is a valid call)
- Remind the bot: `buy_stock` for inverse ETFs (SH, SDS, SQQQ) — never `short_stock` on ETFs

### Register in bots.ts
Add to `runner/src/bots.ts`:
```typescript
export { myBot } from "./bots/<bot-id>.js"
import { myBot } from "./bots/<bot-id>.js"
// add myBot to the bots array
```

Run `bun run typecheck` after changes.

---

## Step 3 — Compute Date Ranges

Run these to get current dates (macOS):
```bash
END=$(date -v-1d +%Y-%m-%d)          # yesterday (backtest cap)
START_7D=$(date -v-10d +%Y-%m-%d)    # ~7 trading days
START_1M=$(date -v-32d +%Y-%m-%d)    # ~1 month
START_1Y=$(date -v-368d +%Y-%m-%d)   # ~1 year
```

---

## Step 4 — Run a Backtest

```bash
# Always run from repo root
cd /Users/panda/dev/trading-bots
bun run runner/src/index.ts --backtest=<bot-id> --start=<START> --end=<END>
```

The backtest automatically uses `data/dev.db`. It will print EOD results per day.

---

## Step 5 — Read Results

```bash
TRADING_ENV=dev bun -e "
process.env.TRADING_ENV = 'dev'
process.env.TRADING_BOTS_DATA_DIR = new URL('./data', import.meta.url).pathname
const { getDb } = await import('./runner/src/db.ts')
const db = getDb()

const run = db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 1').get()
console.log('Return:', (run.total_return * 100).toFixed(2) + '%')
console.log('SPY:   ', (run.spy_return * 100).toFixed(2) + '%')
console.log('Beats SPY:', run.beats_spy ? 'YES' : 'NO')
console.log('Max DD:', (run.max_drawdown * 100).toFixed(2) + '%')

const decisions = db.prepare(\`SELECT sim_date, action, symbol, amount, reasoning FROM decisions WHERE backtest_run_id = ? ORDER BY sim_date\`).all(run.id)
for (const d of decisions) {
  console.log(d.sim_date, d.action.padEnd(12), d.symbol ?? '', (d.reasoning ?? '').slice(0, 80))
}
"
```

---

## Step 5b — Validate DB Integrity (MANDATORY every cycle)

Run this after every backtest before doing anything else. Do not count the cycle as complete or advance the stage until all checks pass.

```bash
cd /Users/panda/dev/trading-bots && TRADING_ENV=dev bun -e "
process.env.TRADING_ENV = 'dev'
process.env.TRADING_BOTS_DATA_DIR = new URL('./data', import.meta.url).pathname
const { getDb } = await import('./runner/src/db.ts')
const db = getDb()

const run = db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 1').get()
const runId = run.id
let issues = []

// 1. Run completed cleanly
if (run.status !== 'completed') issues.push('FAIL run.status=' + run.status + ' (expected completed)')
else console.log('✅ Run status: completed')

// 2. Decisions exist and count is plausible
const decisions = db.prepare('SELECT * FROM decisions WHERE backtest_run_id = ?').all(runId)
const snaps = db.prepare('SELECT * FROM pnl_snapshots WHERE backtest_run_id = ?').all(runId)
if (decisions.length === 0) issues.push('FAIL no decisions recorded')
else console.log('✅ Decisions recorded:', decisions.length)
if (snaps.length === 0) issues.push('FAIL no pnl_snapshots recorded')
else console.log('✅ PnL snapshots recorded:', snaps.length)

// 3. Decisions count matches snapshots count (one decision per trading day)
if (Math.abs(decisions.length - snaps.length) > 3)
  issues.push('WARN decisions (' + decisions.length + ') vs snapshots (' + snaps.length + ') mismatch >3 days')

// 4. No error or max_iterations actions
const badActions = decisions.filter(d => d.action === 'error' || d.action === 'max_iterations')
if (badActions.length > 0) {
  issues.push('WARN ' + badActions.length + ' failed ticks (error/max_iterations):')
  for (const b of badActions) issues.push('  ' + b.sim_date + ' ' + b.action + ': ' + (b.reasoning ?? '').slice(0, 120))
} else console.log('✅ No error/max_iterations actions')

// 5. All decisions have non-empty reasoning
const emptyReasoning = decisions.filter(d => !d.reasoning || d.reasoning.trim() === '')
if (emptyReasoning.length > 0)
  issues.push('WARN ' + emptyReasoning.length + ' decisions missing reasoning: ' + emptyReasoning.map(d => d.sim_date).join(', '))
else console.log('✅ All decisions have reasoning')

// 6. All decisions have tool_calls recorded
const missingTools = decisions.filter(d => !d.tool_calls || d.tool_calls === '[]' || d.tool_calls === 'null')
if (missingTools.length > 0)
  issues.push('WARN ' + missingTools.length + ' decisions have no tool_calls: ' + missingTools.map(d => d.sim_date).join(', '))
else console.log('✅ All decisions have tool_calls')

// 7. No hallucinated tool names in tool_calls
const KNOWN_TOOLS = new Set(['get_market_snapshot','get_portfolio','get_recent_orders','web_search','buy_stock','sell_stock','short_stock','do_nothing'])
const hallucinated = new Set()
for (const d of decisions) {
  if (!d.tool_calls) continue
  let calls
  try { calls = JSON.parse(d.tool_calls) } catch { issues.push('FAIL invalid tool_calls JSON on ' + d.sim_date); continue }
  for (const c of calls) {
    if (c.tool && !KNOWN_TOOLS.has(c.tool)) hallucinated.add(c.tool)
  }
}
if (hallucinated.size > 0)
  issues.push('FAIL hallucinated tool names: ' + [...hallucinated].join(', ') + ' — tighten AVAILABLE TOOLS in system prompt')
else console.log('✅ No hallucinated tool names')

// 8. PnL snapshot values are sane (no zeros, negatives, or astronomical values)
const badSnaps = snaps.filter(s => s.portfolio_value <= 0 || s.portfolio_value > 10_000_000)
if (badSnaps.length > 0)
  issues.push('FAIL ' + badSnaps.length + ' insane portfolio_value rows: ' + badSnaps.map(s => s.sim_date + '=' + s.portfolio_value).join(', '))
else console.log('✅ Portfolio values sane')

const zeroSpy = snaps.filter(s => !s.spy_value || s.spy_value === 0)
if (zeroSpy.length > 0)
  issues.push('WARN ' + zeroSpy.length + ' snapshots missing spy_value (SPY price fetch failed) — SPY return may be inaccurate')
else console.log('✅ SPY benchmark values present')

// 9. beats_spy flag matches actual numbers
const actualBeats = (run.total_return ?? 0) > (run.spy_return ?? 0)
if (!!run.beats_spy !== actualBeats)
  issues.push('FAIL beats_spy flag (' + run.beats_spy + ') disagrees with total_return (' + (run.total_return*100).toFixed(2) + '%) vs spy_return (' + (run.spy_return*100).toFixed(2) + '%)')
else console.log('✅ beats_spy flag consistent with returns')

// 10. Action distribution sanity — warn if >80% do_nothing (bot may be too passive)
const doNothingCount = decisions.filter(d => d.action === 'do_nothing').length
const doNothingPct = (doNothingCount / decisions.length * 100).toFixed(0)
if (doNothingCount / decisions.length > 0.8)
  issues.push('WARN bot called do_nothing ' + doNothingPct + '% of days — may be too passive to generate alpha')
else console.log('✅ Action distribution ok (do_nothing: ' + doNothingPct + '%)')

console.log('')
if (issues.length === 0) {
  console.log('🟢 ALL CHECKS PASSED — cycle is valid')
} else {
  console.log('🔴 ISSUES FOUND (' + issues.length + '):')
  for (const i of issues) console.log(' ', i)
}
"
```

### If validation fails — fix before proceeding

| Issue | Root cause | Fix |
|---|---|---|
| `run.status = failed` | Backtest threw an unrecovered exception | Read the `reasoning` field on action=error rows for the stack trace; fix the underlying problem and re-run |
| `no decisions recorded` | DB write path broken or bot crashed before logging | Check `runner/src/db.ts` `logDecision` is being called; check for unhandled exceptions in bot-runner |
| `decisions/snapshots mismatch` | Some trading days errored out silently | Check backtest runner output for skipped days; investigate per-day errors |
| `error/max_iterations actions` | Bot hit 10 LLM iterations without a terminal tool call | Add explicit "you MUST call buy_stock/sell_stock/do_nothing — do not reason without acting" to prompt |
| `missing reasoning` | LLM returned empty content on some turns | Usually transient; re-run. If persistent, the model may be rate-limited |
| `no tool_calls` | Terminal action fired but wasn't logged | Check `runner/src/bot-runner.ts` toolCallLog push logic |
| `hallucinated tool names` | LLM called a tool not in the MCP list | The AVAILABLE TOOLS block in system prompt is working but LLM ignored it; add explicit "DO NOT call any tool not listed above" line to the bot's system_prompt |
| `insane portfolio_value` | Simulation state file corruption | Delete any stale `.json` files in `data/` and re-run |
| `spy_value = 0` | Alpaca historical bars API failed for SPY | Transient network issue; re-run. If persistent, check Alpaca credentials in `.env` |
| `beats_spy flag wrong` | DB flag out of sync | Bug in `completeBacktestRun` — the flag will still be wrong in DB but you can trust the raw return numbers |
| `do_nothing > 80%` | Bot prompt is too conservative or signal is too rare | Add a "if you have been in cash for 3+ days, you MUST find a position" forcing rule |

---

## Step 6 — Diagnose & Tweak (if stage failed)

Pull the daily P&L to find where alpha was lost:
```bash
TRADING_ENV=dev bun -e "
process.env.TRADING_ENV = 'dev'
process.env.TRADING_BOTS_DATA_DIR = new URL('./data', import.meta.url).pathname
const { getDb } = await import('./runner/src/db.ts')
const db = getDb()
const run = db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 1').get()
const snaps = db.prepare('SELECT sim_date, portfolio_value, spy_value FROM pnl_snapshots WHERE backtest_run_id = ? ORDER BY sim_date').all(run.id)
for (const s of snaps) {
  const bot = ((s.portfolio_value - 100000) / 1000).toFixed(1)
  const spy = ((s.spy_value - 100000) / 1000).toFixed(1)
  const edge = (parseFloat(bot) - parseFloat(spy)).toFixed(1)
  console.log(s.sim_date, 'bot:', bot + '%', 'spy:', spy + '%', 'edge:', edge + 'pp')
}
"
```

### Common failure modes and fixes

| Symptom | Fix |
|---|---|
| Bot sits in cash all week, calls `do_nothing` | Tighten entry criteria, add a "if no position and signal exists, you MUST enter" rule |
| Bot buys wrong instrument (hallucinated ticker) | Add "ONLY trade these specific tickers: ..." to the prompt |
| Bot churns — buys and sells the same thing daily | Add a "do not re-enter a position within 2 days of exiting" rule |
| Bot holds through big drawdowns | Add a hard stop-loss rule: "if position is down >X%, sell immediately" |
| Bot misses the move (action=do_nothing on signal days) | Check if the web_search is returning stale data; add more specific search queries |
| Leverage ETF whipsaw (TQQQ/TNA etc) | Switch to unleveraged version for entries, add leverage only after 2-day confirmation |

---

## Step 7 — Final Report

After completing all stages (success or stop), write a report covering:

1. **Bot thesis** — what it trades and why
2. **Stage-by-stage results table** — cycle, dates, bot return, SPY return, beat?
3. **What worked** — which market conditions favored the strategy
4. **What failed** — where it lost to SPY and why
5. **Prompt iterations** — what changed between cycles
6. **After-tax analysis at $200k MFJ income** for the best result:
   - Bot gross gain → STCG (22% on first $6,700 over $200k, 24% on remainder, NIIT at 3.8% if total > $250k)
   - SPY equivalent → LTCG at 15%
   - Net delta

---

## Quick Reference

```
Repo root:           /Users/panda/dev/trading-bots
Bot files:           runner/src/bots/<bot-id>.ts
Bot registry:        runner/src/bots.ts
Backtest DB:         data/dev.db
Typecheck:           bun run typecheck
Backtest command:    bun run runner/src/index.ts --backtest=<id> --start=YYYY-MM-DD --end=YYYY-MM-DD
```

Available MCP tools the bot can call (injected at runtime):
- `get_market_snapshot` — VIX, SPY/QQQ 1-day and 5-day returns
- `get_portfolio` — current positions with qty and cost basis
- `get_recent_orders` — last N orders placed
- `web_search` — DuckDuckGo + Alpaca news search
- `buy_stock(symbol, dollar_amount, reason)` — buy long
- `sell_stock(symbol, dollar_amount?, reason)` — sell (omit amount = sell all)
- `short_stock(symbol, dollar_amount, reason)` — short individual stocks only
- `do_nothing(reason)` — explicit hold with reasoning
