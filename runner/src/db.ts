import { Database } from "bun:sqlite"
import { join } from "path"
import { mkdirSync } from "fs"

let _db: Database | null = null

/**
 * Returns the path to the active DB file based on TRADING_ENV:
 *   dev     → data/dev.db       (backtesting / local dev)
 *   staging → data/staging.db   (paper trading)
 *   prod    → data/prod.db      (live trading)
 */
function getDbPath(): string {
  const dataDir = process.env.TRADING_BOTS_DATA_DIR ?? join(import.meta.dir, "../../../data")
  mkdirSync(dataDir, { recursive: true })
  const env = process.env.TRADING_ENV ?? "staging"
  return join(dataDir, `${env}.db`)
}

export function getDb(): Database {
  if (_db) return _db
  _db = new Database(getDbPath())
  _db.run("PRAGMA journal_mode=WAL")
  migrate(_db)
  return _db
}

function migrate(db: Database) {
  // ─── Core tables (same schema in dev / staging / prod) ───────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS decisions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id           TEXT NOT NULL,
      mode             TEXT NOT NULL DEFAULT 'live',
      timestamp        TEXT NOT NULL,
      reasoning        TEXT,
      action           TEXT NOT NULL,
      symbol           TEXT,
      amount           REAL,
      fill_price       REAL,
      tool_calls       TEXT NOT NULL DEFAULT '[]',
      backtest_run_id  INTEGER REFERENCES backtest_runs(id),
      sim_date         TEXT
    )
  `)

  // Additive migrations for installs that predate these columns
  try { db.run("ALTER TABLE decisions ADD COLUMN mode TEXT NOT NULL DEFAULT 'live'") } catch {}
  try { db.run("ALTER TABLE decisions ADD COLUMN fill_price REAL") } catch {}
  try { db.run("ALTER TABLE decisions ADD COLUMN backtest_run_id INTEGER") } catch {}
  try { db.run("ALTER TABLE decisions ADD COLUMN sim_date TEXT") } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id           TEXT NOT NULL,
      mode             TEXT NOT NULL DEFAULT 'live',
      timestamp        TEXT NOT NULL,
      portfolio_value  REAL NOT NULL,
      cash             REAL NOT NULL,
      positions        TEXT NOT NULL DEFAULT '{}',
      spy_value        REAL,
      backtest_run_id  INTEGER REFERENCES backtest_runs(id),
      sim_date         TEXT
    )
  `)

  try { db.run("ALTER TABLE pnl_snapshots ADD COLUMN mode TEXT NOT NULL DEFAULT 'live'") } catch {}
  try { db.run("ALTER TABLE pnl_snapshots ADD COLUMN spy_value REAL") } catch {}
  try { db.run("ALTER TABLE pnl_snapshots ADD COLUMN backtest_run_id INTEGER") } catch {}
  try { db.run("ALTER TABLE pnl_snapshots ADD COLUMN sim_date TEXT") } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS seen_content (
      bot_id      TEXT NOT NULL,
      content_id  TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      PRIMARY KEY (bot_id, content_id)
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_decisions_bot_id
    ON decisions(bot_id, timestamp DESC)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_decisions_backtest_run
    ON decisions(backtest_run_id, sim_date)
    WHERE backtest_run_id IS NOT NULL
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_pnl_bot_id
    ON pnl_snapshots(bot_id, timestamp DESC)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_pnl_backtest_run
    ON pnl_snapshots(backtest_run_id, sim_date)
    WHERE backtest_run_id IS NOT NULL
  `)

  // ─── Position reasons ─────────────────────────────────────────────────────────
  // The LLM's stated reason for each open (or historically open) position.
  // Injected back into context each run so the agent can re-evaluate conviction.
  // Rows are NEVER auto-deleted — closed_at is set on full exit.

  db.run(`
    CREATE TABLE IF NOT EXISTS position_reasons (
      bot_id        TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      reason        TEXT NOT NULL,
      entered_at    TEXT NOT NULL,
      entry_amount  REAL,
      closed_at     TEXT,
      PRIMARY KEY (bot_id, symbol)
    )
  `)

  // Drop legacy table (renamed to position_reasons)
  db.run(`DROP TABLE IF EXISTS position_theses`)

  // ─── Backtest run metadata ────────────────────────────────────────────────────
  // Lives in dev.db only, but defining it in all envs is harmless.

  db.run(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      sim_start     TEXT NOT NULL,
      sim_end       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',
      total_return  REAL,
      spy_return    REAL,
      max_drawdown  REAL,
      beats_spy     INTEGER
    )
  `)
}

// ─── Decision helpers ─────────────────────────────────────────────────────────

export function logDecision(params: {
  botId: string
  mode?: string
  reasoning: string
  action: string
  symbol?: string
  amount?: number
  fillPrice?: number
  toolCalls: unknown[]
  backtestRunId?: number
  simDate?: string
}) {
  const db = getDb()
  db.run(
    `INSERT INTO decisions
       (bot_id, mode, timestamp, reasoning, action, symbol, amount, fill_price, tool_calls, backtest_run_id, sim_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.botId,
      params.mode ?? (params.backtestRunId != null ? "backtest" : "live"),
      new Date().toISOString(),
      params.reasoning,
      params.action,
      params.symbol ?? null,
      params.amount ?? null,
      params.fillPrice ?? null,
      JSON.stringify(params.toolCalls),
      params.backtestRunId ?? null,
      params.simDate ?? null,
    ],
  )
}

// ─── PnL snapshot helpers ─────────────────────────────────────────────────────

export function logPnlSnapshot(params: {
  botId: string
  mode?: string
  portfolioValue: number
  cash: number
  positions: unknown
  spyValue?: number
  backtestRunId?: number
  simDate?: string
}) {
  const db = getDb()
  db.run(
    `INSERT INTO pnl_snapshots
       (bot_id, mode, timestamp, portfolio_value, cash, positions, spy_value, backtest_run_id, sim_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.botId,
      params.mode ?? (params.backtestRunId != null ? "backtest" : "live"),
      new Date().toISOString(),
      params.portfolioValue,
      params.cash,
      JSON.stringify(params.positions),
      params.spyValue ?? null,
      params.backtestRunId ?? null,
      params.simDate ?? null,
    ],
  )
}

export function hasSeenContent(botId: string, contentId: string): boolean {
  const db = getDb()
  const row = db.query(
    "SELECT 1 FROM seen_content WHERE bot_id = ? AND content_id = ?"
  ).get(botId, contentId)
  return row !== null
}

export function markContentSeen(botId: string, contentId: string) {
  const db = getDb()
  db.run(
    `INSERT OR IGNORE INTO seen_content (bot_id, content_id, timestamp)
     VALUES (?, ?, ?)`,
    [botId, contentId, new Date().toISOString()],
  )
}

// ─── Position reasons ─────────────────────────────────────────────────────────

export interface PositionReason {
  bot_id: string
  symbol: string
  reason: string
  entered_at: string
  entry_amount: number | null
  closed_at: string | null
}

export function upsertPositionReason(params: {
  botId: string
  symbol: string
  reason: string
  entryAmount?: number
}) {
  const db = getDb()
  db.run(
    `INSERT INTO position_reasons (bot_id, symbol, reason, entered_at, entry_amount, closed_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(bot_id, symbol) DO UPDATE SET
       reason       = excluded.reason,
       entered_at   = excluded.entered_at,
       entry_amount = excluded.entry_amount,
       closed_at    = NULL`,
    [params.botId, params.symbol.toUpperCase(), params.reason, new Date().toISOString(), params.entryAmount ?? null],
  )
}

export function closePositionReason(botId: string, symbol: string) {
  const db = getDb()
  db.run(
    `UPDATE position_reasons SET closed_at = ? WHERE bot_id = ? AND symbol = ?`,
    [new Date().toISOString(), botId, symbol.toUpperCase()],
  )
}

export function updatePositionReasonAmount(botId: string, symbol: string, newAmount: number) {
  const db = getDb()
  db.run(
    `UPDATE position_reasons SET entry_amount = ?
     WHERE bot_id = ? AND symbol = ? AND closed_at IS NULL`,
    [newAmount, botId, symbol.toUpperCase()],
  )
}

export function getPositionReasons(botId: string): PositionReason[] {
  const db = getDb()
  return db
    .query<PositionReason, [string]>(
      `SELECT * FROM position_reasons WHERE bot_id = ? AND closed_at IS NULL ORDER BY entered_at ASC`,
    )
    .all(botId)
}

/** Wipe all open position reasons for a bot — called before a fresh backtest run */
export function clearPositionReasons(botId: string) {
  const db = getDb()
  db.run(`DELETE FROM position_reasons WHERE bot_id = ?`, [botId])
}

// ─── Backtest run helpers ─────────────────────────────────────────────────────

export function createBacktestRun(params: {
  botId: string
  simStart: string
  simEnd: string
}): number {
  const db = getDb()
  db.run(
    `INSERT INTO backtest_runs (bot_id, started_at, sim_start, sim_end, status)
     VALUES (?, ?, ?, ?, 'running')`,
    [params.botId, new Date().toISOString(), params.simStart, params.simEnd],
  )
  const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!
  return row.id
}

export function completeBacktestRun(params: {
  runId: number
  totalReturn: number
  spyReturn: number
  maxDrawdown: number
}) {
  const db = getDb()
  const beatsSpy = params.totalReturn > params.spyReturn ? 1 : 0
  db.run(
    `UPDATE backtest_runs
     SET status = 'completed', completed_at = ?, total_return = ?, spy_return = ?, max_drawdown = ?, beats_spy = ?
     WHERE id = ?`,
    [new Date().toISOString(), params.totalReturn, params.spyReturn, params.maxDrawdown, beatsSpy, params.runId],
  )
}

export function failBacktestRun(runId: number, _error: string) {
  const db = getDb()
  db.run(
    `UPDATE backtest_runs SET status = 'failed', completed_at = ? WHERE id = ?`,
    [new Date().toISOString(), runId],
  )
}

export function getBacktestPnlHistory(runId: number) {
  const db = getDb()
  return db
    .query(
      `SELECT * FROM pnl_snapshots WHERE backtest_run_id = ? ORDER BY sim_date ASC`,
    )
    .all(runId)
}

// ─── Read helpers (used by webapp + scheduler) ────────────────────────────────

export function getRecentDecisions(botId: string, limit = 20) {
  const db = getDb()
  return db
    .query(`SELECT * FROM decisions WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?`)
    .all(botId, limit)
}

export function getPnlHistory(botId: string, limit = 200) {
  const db = getDb()
  return db
    .query(`SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp ASC LIMIT ?`)
    .all(botId, limit)
}

export function getLatestPnl(botId: string) {
  const db = getDb()
  return db
    .query(`SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp DESC LIMIT 1`)
    .get(botId)
}

