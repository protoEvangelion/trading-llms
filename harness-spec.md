# Harness-Mode Architecture Spec

## What This Is

A new execution path where a long-lived AI CLI (Claude Code, Gemini CLI, or GitHub Copilot CLI)
is the trading brain for a bot thesis. The harness persists for the entire backtest or live run,
accumulating context across days, and compacts automatically when needed.

This sits **alongside** the existing agent-mode (`index.ts` / `backtest-runner.ts` / `bot-runner.ts`).
Nothing in agent-mode is modified.

---

## What Stays Untouched

All existing files are read-only from harness-mode's perspective:
- `runner/src/index.ts` — agent-mode entry point, untouched
- `runner/src/bot-runner.ts` — agent-mode agentic loop, untouched
- `runner/src/backtest-runner.ts` — agent-mode backtest orchestrator, untouched
- `runner/src/scheduler.ts` — cron scheduling for agent-mode, untouched
- `runner/src/mcps/trade.ts` — live trade MCP, untouched
- `runner/src/mcps/backtest-trade.ts` — sim trade MCP, **minor addition** (see sim-date resolution below)
- `runner/src/mcps/trump-posts.ts` — **minor addition** (see sim-date resolution below)
- `runner/src/mcps/web-search.ts` — **minor addition** (see sim-date resolution below)
- `runner/src/bots.ts` — shared thesis registry, untouched
- `runner/src/db.ts` — additive migrations only (new `runs` table + `run_id` columns)

---

## New File Layout

```
runner/src/
  harness.ts                        ← standalone CLI entry point (NEW)
  harness-mode/
    runner.ts                       ← orchestrates launch, state init, monitoring (NEW)
    harnesses/
      index.ts                      ← HarnessAdapter interface + factory (NEW)
      claude.ts                     ← Claude Code CLI adapter (NEW)
      gemini.ts                     ← Gemini CLI adapter (NEW)
      copilot.ts                    ← GitHub Copilot CLI adapter (NEW)
    mcps/
      sim-clock.ts                  ← sim time control MCP server (NEW)
```

---

## CLI Interface (`harness.ts`)

Standalone entry point, completely separate from `index.ts`.

```bash
bun run runner/src/harness.ts [flags]
```

### Required flags
| Flag | Description |
|---|---|
| `--harness=<name>` | `claude` \| `gemini` \| `copilot` |
| `--thesis=<id>` | Bot ID from `bots.ts` (e.g. `trump`, `datacenter`) |
| `--mode=<mode>` | `backtest` \| `paper` \| `live` |

### Conditional flags
| Flag | Required when | Description |
|---|---|---|
| `--start=YYYY-MM-DD` | `--mode=backtest` | Backtest start date |
| `--end=YYYY-MM-DD` | `--mode=backtest` | Backtest end date (capped to yesterday) |

### Optional flags
| Flag | Default | Description |
|---|---|---|
| `--model=<id>` | harness default | Model override passed to the harness CLI |
| `--resume` | false | Resume last `running` session for this thesis+mode |

### Examples
```bash
# Backtest
bun run runner/src/harness.ts --harness=claude --thesis=trump --mode=backtest --start=2025-01-01 --end=2025-03-01

# Paper trading (long-lived process)
bun run runner/src/harness.ts --harness=gemini --thesis=datacenter --mode=paper

# Resume a crashed paper session
bun run runner/src/harness.ts --harness=claude --thesis=trump --mode=paper --resume

# With model override
bun run runner/src/harness.ts --harness=claude --model=claude-opus-4-5 --thesis=trump --mode=backtest --start=2025-01-01 --end=2025-02-01
```

### Env resolution
- `--mode=backtest` → `TRADING_ENV=dev`
- `--mode=paper`    → `TRADING_ENV=staging`
- `--mode=live`     → `TRADING_ENV=prod`

---

## Harness Adapters

### Interface (`harness-mode/harnesses/index.ts`)

```typescript
export interface HarnessLaunchConfig {
  model?: string
  workingDir: string          // temp dir containing context files + MCP config
  initialPrompt: string       // first message sent to the harness
  sessionId?: string          // set when resuming
}

export interface HarnessSession {
  sessionId: string           // stored in DB for resume
  process: ChildProcess
  waitForExit(): Promise<number>  // resolves with exit code
}

export interface HarnessAdapter {
  readonly name: string
  launch(config: HarnessLaunchConfig): Promise<HarnessSession>
}
```

Factory function: `getHarnessAdapter(name: 'claude' | 'gemini' | 'copilot'): HarnessAdapter`

---

### Claude Code (`claude.ts`)

**Prerequisites:** `claude` CLI installed and authenticated.

**Working dir structure:**
```
{workingDir}/
  CLAUDE.md               ← thesis context + backtest protocol instructions
  .claude/
    settings.json         ← MCP server configs (sim-clock + thesis MCPs)
```

**Launch:**
```bash
claude --dangerously-skip-permissions [--model <model>]
```
Started with an initial prompt piped via stdin or `--print` flag.

**Resume:**
```bash
claude --dangerously-skip-permissions --resume <session-id>
```

**Session ID:** Extracted from Claude's stdout on first launch (Claude Code prints its session ID at startup). Stored in `runs.harness_session_id`.

**MCP config format** (`.claude/settings.json`):
```json
{
  "mcpServers": {
    "sim-clock": {
      "command": "bun",
      "args": ["run", "/abs/path/to/runner/src/harness-mode/mcps/sim-clock.ts"],
      "env": { "SIM_CLOCK_STATE_FILE": "/abs/path/to/{runId}-sim-clock.json" }
    },
    "trump-posts": { ... },
    "web-search": { ... },
    "backtest-trade": { ... }
  }
}
```

---

### Gemini CLI (`gemini.ts`)

**Prerequisites:** `gemini` CLI installed and authenticated.

**Working dir structure:**
```
{workingDir}/
  GEMINI.md               ← thesis context (Gemini reads this automatically)
  .gemini/
    settings.json         ← MCP server configs
```

**Launch:**
```bash
gemini [--model <model>] --yolo
```

**Resume:** TBD — depends on Gemini CLI session resumption API. Adapter will stub this until confirmed.

**Session ID:** Extracted from Gemini CLI output at startup.

**Note:** Gemini CLI MCP config format may differ from Claude's — adapter is responsible for writing the correct format.

---

### GitHub Copilot CLI (`copilot.ts`)

**Prerequisites:** `npm install -g @github/copilot` + GitHub auth.

**Working dir structure:**
```
{workingDir}/
  COPILOT.md              ← thesis context
  .copilot/
    mcp.json              ← MCP server configs (GitHub's /mcp integration format)
```

**Launch:**
```bash
copilot [--model <model>]
```

**Resume:** Copilot CLI uses `/resume` slash command within a session. The adapter stores a session reference and passes it back at launch time.

**Session ID:** Extracted from Copilot CLI output at startup.

**Note:** Copilot CLI's MCP config format uses GitHub's native `/mcp` integration — exact config schema TBD from `@github/copilot` docs.

---

## sim-clock MCP (`harness-mode/mcps/sim-clock.ts`)

Runs as a stdio MCP server. Owns the simulation clock for the entire run.
State is persisted in a JSON file shared with all other MCPs.

### State file (`{dataDir}/{runId}-sim-clock.json`)
```json
{
  "runId": 42,
  "mode": "backtest",
  "tradingDays": ["2025-01-02", "2025-01-03", ...],
  "currentDayIndex": 0,
  "completed": false
}
```

### Environment variables
| Var | Description |
|---|---|
| `SIM_CLOCK_STATE_FILE` | Absolute path to the state JSON file |

### Tools (backtest mode)

**`get_sim_state()`**
Returns current simulation status.
```json
{
  "currentDate": "2025-01-02",
  "dayNumber": 1,
  "totalDays": 65,
  "daysRemaining": 64,
  "completed": false
}
```

**`advance_to_next_trading_day()`**
Increments the day index in the state file, returns next date.
All MCPs that read `SIM_CLOCK_STATE_FILE` will see the new date on their next call.
```json
// Normal advance:
{ "date": "2025-01-03", "dayNumber": 2, "daysRemaining": 63 }

// Backtest complete:
{ "done": true, "message": "Backtest complete. All 65 trading days simulated." }
```

**`get_trading_calendar()`**
Returns the full list of trading days for the run.
```json
{ "days": ["2025-01-02", "2025-01-03", ...], "total": 65 }
```

### Tools (paper/live mode)

**`get_current_time()`**
Returns real wall-clock time in ET.
```json
{
  "datetime": "2025-04-18T09:15:00",
  "timezone": "America/New_York",
  "marketOpen": true
}
```
No `advance_*` tools exposed in paper/live mode.

---

## Sim-Date Resolution in Existing MCPs

**The problem:** In agent-mode, `SIM_DATE` is injected as an env var at MCP boot time. In harness-mode, the sim date changes across days but MCPs stay running (managed by the harness CLI).

**The fix (minor, additive):** Each date-sensitive MCP checks for `SIM_CLOCK_STATE_FILE` env var. If set, it reads the current `tradingDays[currentDayIndex]` from that file on each tool call, overriding `SIM_DATE`.

Files affected: `mcps/trump-posts.ts`, `mcps/web-search.ts`, `mcps/backtest-trade.ts`

Backward compatible — if `SIM_CLOCK_STATE_FILE` is not set, existing `SIM_DATE` env var behavior is unchanged. Agent-mode is unaffected.

Helper (shared): `runner/src/harness-mode/mcps/sim-clock.ts` exports a `readSimDate()` function that the other MCPs import.

---

## Database Changes (`db.ts`)

### New `runs` table

Unified table replacing `backtest_runs`. Covers all execution modes.

```sql
CREATE TABLE IF NOT EXISTS runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id             TEXT NOT NULL,
  harness            TEXT NOT NULL DEFAULT 'legacy',   -- claude | gemini | copilot | legacy
  mode               TEXT NOT NULL DEFAULT 'backtest', -- backtest | paper | live
  started_at         TEXT NOT NULL,
  completed_at       TEXT,
  sim_start          TEXT,           -- NULL for paper/live
  sim_end            TEXT,           -- NULL for paper/live
  status             TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed
  total_return       REAL,
  spy_return         REAL,
  max_drawdown       REAL,
  beats_spy          INTEGER,        -- 0 | 1, NULL for paper/live
  harness_session_id TEXT            -- for --resume support
)
```

### Migration strategy

`backtest_runs` stays in place (it's referenced by existing webapp queries and decisions FKs).
`runs` is a new additive table. New harness-mode code writes to `runs`.

Existing `backtest_run_id` FK on `decisions` and `pnl_snapshots` stays as-is.
New `run_id` column added additively to both tables for harness-mode rows.

```sql
-- Additive only, no renames
ALTER TABLE decisions ADD COLUMN run_id INTEGER REFERENCES runs(id);
ALTER TABLE pnl_snapshots ADD COLUMN run_id INTEGER REFERENCES runs(id);
```

Future cleanup (post-validation): migrate webapp queries from `backtest_runs` to `runs`,
then drop `backtest_runs`. Not in scope for this implementation.

---

## Harness Runner (`harness-mode/runner.ts`)

Orchestrates the full lifecycle. Called by `harness.ts`.

### Startup sequence
1. Load `.env`, set `TRADING_ENV` from `--mode`
2. Look up bot config from `bots.ts` by `--thesis`
3. Resolve trading days (backtest) or skip (paper/live)
4. Create `runs` record in DB with `status = 'running'`
5. Write sim-clock state file to `data/{runId}-sim-clock.json`
6. Create temp working dir under `/tmp/trading-harness-{runId}/`
7. Write context file (CLAUDE.md / GEMINI.md / COPILOT.md) with:
   - Bot's `system_prompt` verbatim
   - Backtest protocol instructions (call advance when done with each day, exit when done=true)
   - Available tool list
8. Write MCP config in harness-specific format
9. Build `initialPrompt` (see below)
10. Launch harness adapter (or resume if `--resume`)
11. Write `harness_session_id` back to `runs` row
12. Await process exit
13. On exit: finalize `runs` record, calculate metrics from DB, clean up temp dir

### Resume flow (`--resume`)
1. Query DB: `SELECT * FROM runs WHERE bot_id=? AND mode=? AND status='running' ORDER BY started_at DESC LIMIT 1`
2. If found: pass `sessionId = runs.harness_session_id` to adapter's `launch()` config
3. Adapter uses `--resume <id>` (or equivalent) instead of fresh launch

### Initial prompt (backtest)
```
You are running a historical backtest for the {bot.name} thesis from {start} to {end}.

Call get_sim_state() to see your current position in the backtest.
For each trading day:
  1. Gather signals using your available tools (news, posts, portfolio)
  2. Make your trading decision (buy, sell, or hold)
  3. Call advance_to_next_trading_day() when finished with the day
When advance_to_next_trading_day() returns done=true, the backtest is complete.
Summarize your final performance and exit.
```

### Initial prompt (paper/live)
```
You are the live trading agent for the {bot.name} thesis.
You run continuously. Use get_current_time() to check market hours.
Monitor your positions, gather signals at appropriate intervals,
and make trading decisions when conditions warrant.
This process runs indefinitely — resume naturally after any restart.
```

### Monitoring
- Harness process stdout/stderr piped to runner's stdout (visible to operator)
- On `SIGINT` / `SIGTERM`: forward signal to harness process, wait for graceful exit, mark run `failed` if exit code != 0
- Backtest: `process.exit(0)` when harness exits cleanly (harness self-terminates after seeing `done=true`)
- Paper/live: runner stays alive indefinitely; operator kills it with Ctrl+C

---

## Context Files

### CLAUDE.md (Claude Code)
Written to `{workingDir}/CLAUDE.md`. Contains:
- Bot's `system_prompt` (the thesis)
- Backtest protocol (advance_to_next_trading_day loop)
- Tool descriptions (brief, harness discovers full schema from MCPs)
- Anti-lookahead reminder (sim tools enforce this, but remind anyway)

Claude Code auto-loads this as persistent project context.

### GEMINI.md / COPILOT.md
Same content, different filename per harness convention.
Gemini and Copilot CLI may load these automatically; if not, content is embedded in `initialPrompt`.

---

## Harness Lifecycle Summary

| Mode | Exit condition | `runs.status` on exit |
|---|---|---|
| backtest | Harness sees `done=true` from `advance_to_next_trading_day()`, summarizes, exits | `completed` |
| paper | Never exits unless killed | stays `running`; `failed` if killed uncleanly |
| live | Never exits unless killed | stays `running`; `failed` if killed uncleanly |

For paper/live: the `runs` row with `status='running'` is the resume anchor.
`--resume` finds it and restarts the harness session where it left off.

---

## What the Harness Knows vs. What the MCP Enforces

| Concern | Who handles it |
|---|---|
| Current sim date | sim-clock MCP (state file) |
| No lookahead on posts | trump-posts MCP (reads simDate from state file) |
| No lookahead on news | web-search MCP (reads simDate from state file) |
| Fill prices at sim open | backtest-trade MCP (unchanged) |
| P&L logging | backtest-trade MCP (writes to DB directly, same as agent-mode) |
| Decision logging | backtest-trade MCP or harness via a `log_decision` tool (TBD) |
| When to advance the day | harness decides (calls `advance_to_next_trading_day()`) |
| When backtest is done | sim-clock MCP tells harness via `done=true` |

---

## Open Questions / Notes

1. **Decision logging in harness-mode:** In agent-mode, `logDecision()` is called by `bot-runner.ts`
   after each tick. In harness-mode, the harness itself makes decisions across turns — there's no
   single "decision point" per tick. Options:
   - Add a `log_decision(action, symbol, amount, reasoning)` tool to sim-clock or a new MCP
   - The harness calls it explicitly after each buy/sell/hold decision
   - `backtest-trade.ts` MCP already logs fills — this may be sufficient for backtest analytics

2. **Gemini CLI session resume:** Exact `--resume` flag syntax unknown. `gemini.ts` adapter will
   need verification against the actual installed CLI. May require a `gemini sessions list` step.

3. **Copilot CLI MCP config format:** `@github/copilot`'s `/mcp` integration format needs
   verification from the installed package docs. The adapter stubs this until confirmed.

4. **Compaction:** Claude Code handles this natively. Gemini CLI and Copilot CLI compaction
   behavior is harness-managed and transparent to our code — no changes needed from our side.

5. **Paper/live scheduling:** In agent-mode, `scheduler.ts` fires bots on a cron. In harness-mode,
   the harness itself decides when to act (checking market hours via `get_current_time()`). The
   harness prompt instructs it to respect market hours — this is a behavioral property, not enforced
   by our tooling. Consider adding a `wait_until_market_open()` tool to sim-clock for paper/live.

6. **Multiple concurrent harness runs:** Not supported in v1. Running two harness instances for
   the same bot would conflict on `position_reasons` in the DB. Future: namespace by `run_id`.
