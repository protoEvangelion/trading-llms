import { Database } from "bun:sqlite"
import { join } from "path"
import { mkdirSync } from "fs"

let _db: Database | null = null

function getDbPath(): string {
  // Use env var if set (set by index.ts before anything runs),
  // otherwise resolve relative to this source file
  const dataDir = process.env.TRADING_BOTS_DATA_DIR ?? join(import.meta.dir, "../../../data")
  mkdirSync(dataDir, { recursive: true })
  return join(dataDir, "trading.db")
}

export function getDb(): Database {
  if (_db) return _db
  _db = new Database(getDbPath())
  _db.run("PRAGMA journal_mode=WAL")
  migrate(_db)
  return _db
}

function migrate(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS decisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id          TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      reasoning       TEXT,
      action          TEXT NOT NULL,
      symbol          TEXT,
      amount          REAL,
      tool_calls      TEXT NOT NULL DEFAULT '[]'
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id          TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      portfolio_value REAL NOT NULL,
      cash            REAL NOT NULL,
      positions       TEXT NOT NULL DEFAULT '{}'
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS seen_content (
      bot_id          TEXT NOT NULL,
      content_id      TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      PRIMARY KEY (bot_id, content_id)
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_decisions_bot_id
    ON decisions(bot_id, timestamp DESC)
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_pnl_bot_id
    ON pnl_snapshots(bot_id, timestamp DESC)
  `)

  // Stores the LLM's reasoning for each open position so future runs can
  // evaluate whether the original thesis still holds.
  db.run(`
    CREATE TABLE IF NOT EXISTS position_theses (
      bot_id        TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      thesis        TEXT NOT NULL,
      entered_at    TEXT NOT NULL,
      entry_amount  REAL,
      PRIMARY KEY (bot_id, symbol)
    )
  `)
}

export function logDecision(params: {
  botId: string
  reasoning: string
  action: string
  symbol?: string
  amount?: number
  toolCalls: unknown[]
}) {
  const db = getDb()
  db.run(
    `INSERT INTO decisions (bot_id, timestamp, reasoning, action, symbol, amount, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      params.botId,
      new Date().toISOString(),
      params.reasoning,
      params.action,
      params.symbol ?? null,
      params.amount ?? null,
      JSON.stringify(params.toolCalls),
    ]
  )
}

export function logPnlSnapshot(params: {
  botId: string
  portfolioValue: number
  cash: number
  positions: unknown
}) {
  const db = getDb()
  db.run(
    `INSERT INTO pnl_snapshots (bot_id, timestamp, portfolio_value, cash, positions)
     VALUES (?, ?, ?, ?, ?)`,
    [
      params.botId,
      new Date().toISOString(),
      params.portfolioValue,
      params.cash,
      JSON.stringify(params.positions),
    ]
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
    [botId, contentId, new Date().toISOString()]
  )
}

// ─── Position theses ──────────────────────────────────────────────────────────

export interface PositionThesis {
  bot_id: string
  symbol: string
  thesis: string
  entered_at: string
  entry_amount: number | null
}

/** Upsert the LLM's thesis for a newly opened (or added-to) position */
export function upsertPositionThesis(params: {
  botId: string
  symbol: string
  thesis: string
  entryAmount?: number
}) {
  const db = getDb()
  db.run(
    `INSERT INTO position_theses (bot_id, symbol, thesis, entered_at, entry_amount)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bot_id, symbol) DO UPDATE SET
       thesis       = excluded.thesis,
       entered_at   = excluded.entered_at,
       entry_amount = excluded.entry_amount`,
    [params.botId, params.symbol.toUpperCase(), params.thesis, new Date().toISOString(), params.entryAmount ?? null],
  )
}

/** Remove the thesis when a position is fully closed */
export function deletePositionThesis(botId: string, symbol: string) {
  const db = getDb()
  db.run(
    `DELETE FROM position_theses WHERE bot_id = ? AND symbol = ?`,
    [botId, symbol.toUpperCase()],
  )
}

/** Get all active position theses for a bot */
export function getPositionTheses(botId: string): PositionThesis[] {
  const db = getDb()
  return db.query<PositionThesis, [string]>(
    `SELECT * FROM position_theses WHERE bot_id = ? ORDER BY entered_at ASC`,
  ).all(botId)
}

export function getRecentDecisions(botId: string, limit = 20) {
  const db = getDb()
  return db.query(
    `SELECT * FROM decisions WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(botId, limit)
}

export function getPnlHistory(botId: string, limit = 200) {
  const db = getDb()
  return db.query(
    `SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp ASC LIMIT ?`
  ).all(botId, limit)
}

export function getLatestPnl(botId: string) {
  const db = getDb()
  return db.query(
    `SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp DESC LIMIT 1`
  ).get(botId)
}
