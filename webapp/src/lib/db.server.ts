// bun:sqlite is Bun's built-in — works in TanStack Start server functions
import { Database } from "bun:sqlite"
import { join } from "path"
import { existsSync } from "fs"

const DB_PATH = join(import.meta.dirname, "../../../data/trading.db")

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}. Run the bot runner first.`)
  }
  _db = new Database(DB_PATH, { readonly: true })
  return _db
}

export interface Decision {
  id: number
  bot_id: string
  timestamp: string
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
    const latestPnl = db.query<PnlSnapshot, string>(
      "SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp DESC LIMIT 1"
    ).get(botId)

    const firstPnl = db.query<PnlSnapshot, string>(
      "SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp ASC LIMIT 1"
    ).get(botId)

    const lastDecision = db.query<Decision, string>(
      "SELECT * FROM decisions WHERE bot_id = ? ORDER BY timestamp DESC LIMIT 1"
    ).get(botId)

    const { count: totalDecisions } = db.query<{ count: number }, string>(
      "SELECT COUNT(*) as count FROM decisions WHERE bot_id = ?"
    ).get(botId) ?? { count: 0 }

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
      latestPnl: latestPnl ?? null,
      lastDecision: lastDecision ?? null,
      totalReturn,
      totalDecisions,
    }
  })
}

export function getPnlHistory(botId: string, limit = 500): PnlSnapshot[] {
  const db = getDb()
  return db.query<PnlSnapshot, [string, number]>(
    "SELECT * FROM pnl_snapshots WHERE bot_id = ? ORDER BY timestamp ASC LIMIT ?"
  ).all(botId, limit)
}

export function getDecisions(botId: string, limit = 50): Decision[] {
  const db = getDb()
  return db.query<Decision, [string, number]>(
    "SELECT * FROM decisions WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?"
  ).all(botId, limit)
}
