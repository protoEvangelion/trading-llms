import BetterSqlite3 from "better-sqlite3"
import { join } from "path"
import { existsSync } from "fs"

type Database = BetterSqlite3.Database

// Mirror the runner's env-based DB selection.
// Default to staging (paper trading) since that's what the webapp monitors.
const env = process.env.TRADING_ENV ?? "staging"
const DB_PATH = join(import.meta.dirname, `../../../data/${env}.db`)

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}. Run the bot runner first.`)
  }
  _db = new BetterSqlite3(DB_PATH, { readonly: true })
  return _db
}

export interface Decision {
  id: number
  bot_id: string
  timestamp: string
  sim_date: string | null
  reasoning: string | null
  action: string
  symbol: string | null
  amount: number | null
  tool_calls: string
}

export interface PnlSnapshot {
  id: number
  bot_id: string
  timestamp: string
  portfolio_value: number
  cash: number
  positions: string
  spy_value: number | null
  sim_date: string | null
}

export interface BotSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  cron: string
  model: string
  latestPnl: PnlSnapshot | null
  lastDecision: Decision | null
  totalReturn: number | null
  totalDecisions: number
}

export function getAllBotSummaries(botIds: string[]): BotSummary[] {
  const db = getDb()
  return botIds.map((botId) => {
    const latestPnl = db.prepare<PnlSnapshot, [string]>(
      "SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp DESC LIMIT 1"
    ).get(botId) ?? null

    const firstPnl = db.prepare<PnlSnapshot, [string]>(
      "SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp ASC LIMIT 1"
    ).get(botId) ?? null

    const lastDecision = db.prepare<Decision, [string]>(
      "SELECT * FROM decisions WHERE bot_id = ? ORDER BY timestamp DESC LIMIT 1"
    ).get(botId) ?? null

    const row = db.prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM decisions WHERE bot_id = ?"
    ).get(botId)
    const totalDecisions = row?.count ?? 0

    let totalReturn: number | null = null
    if (latestPnl && firstPnl) {
      totalReturn =
        ((latestPnl.portfolio_value - firstPnl.portfolio_value) /
          firstPnl.portfolio_value) *
        100
    }

    return {
      id: botId,
      name: botId,
      description: "",
      enabled: true,
      cron: "",
      model: "",
      latestPnl,
      lastDecision,
      totalReturn,
      totalDecisions,
    }
  })
}

export function getPnlHistory(botId: string, limit = 500): PnlSnapshot[] {
  const db = getDb()
  return db.prepare<PnlSnapshot, [string, number]>(
    "SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp ASC LIMIT ?"
  ).all(botId, limit)
}

export function getDecisions(botId: string, limit = 50): Decision[] {
  const db = getDb()
  return db.prepare<Decision, [string, number]>(
    "SELECT * FROM decisions WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?"
  ).all(botId, limit)
}
