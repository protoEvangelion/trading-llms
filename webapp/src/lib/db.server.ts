import BetterSqlite3 from "better-sqlite3"
import { join } from "path"
import { existsSync } from "fs"
import type { AppMode } from "./mode"

type Database = BetterSqlite3.Database

interface DbSchemaCapabilities {
  hasRunsTable: boolean
  hasBacktestRunsTable: boolean
  decisionsHasRunId: boolean
  pnlHasRunId: boolean
   runsHasModel: boolean
}

const MODE_DB_NAME: Record<AppMode, string> = {
  backtesting: "dev",
  paper: "staging",
  live: "prod",
}

const dbCache = new Map<AppMode, Database>()
const schemaCache = new Map<AppMode, DbSchemaCapabilities>()

function getDb(mode: AppMode): Database | null {
  const cached = dbCache.get(mode)
  if (cached) return cached

  const dbPath = join(import.meta.dirname, `../../../data/${MODE_DB_NAME[mode]}.db`)
  if (!existsSync(dbPath)) {
    return null
  }

  const db = new BetterSqlite3(dbPath, { readonly: true })
  dbCache.set(mode, db)
  return db
}

function hasTable(db: Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).get(tableName) as { name: string } | undefined
  return row?.name === tableName
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

function getSchemaCapabilities(mode: AppMode, db: Database): DbSchemaCapabilities {
  const cached = schemaCache.get(mode)
  if (cached) return cached

  const capabilities: DbSchemaCapabilities = {
    hasRunsTable: hasTable(db, "runs"),
    hasBacktestRunsTable: hasTable(db, "backtest_runs"),
    decisionsHasRunId: hasColumn(db, "decisions", "run_id"),
    pnlHasRunId: hasColumn(db, "pnl_snapshots", "run_id"),
    runsHasModel: hasTable(db, "runs") && hasColumn(db, "runs", "model"),
  }

  schemaCache.set(mode, capabilities)
  return capabilities
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
  spyReturn: number | null
  returnVsSpy: number | null
  totalDecisions: number
  runMeta: RunMeta | null
}

export interface RunMeta {
  id: number
  source: "harness" | "legacy"
  mode: "backtest" | "paper" | "live"
  harness: string | null
  model: string | null
  simStart: string | null
  simEnd: string | null
  completedAt: string | null
  isFullYear: boolean
}

type BacktestRunRef = RunMeta

function normalizeRunModel(model: string | null | undefined): string | null {
  return model && model.trim().length > 0 ? model : null
}

function getHarnessModelSelect(capabilities: DbSchemaCapabilities): string {
  return capabilities.runsHasModel ? "model" : "NULL as model"
}

function getInclusiveDaySpan(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const startTime = Date.parse(`${start}T00:00:00Z`)
  const endTime = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime) return null
  return Math.floor((endTime - startTime) / 86_400_000) + 1
}

function isFullYearRun(start: string | null, end: string | null): boolean {
  const daySpan = getInclusiveDaySpan(start, end)
  return daySpan != null && daySpan >= 365
}

function getLatestBacktestRun(
  db: Database,
  capabilities: DbSchemaCapabilities,
  botId: string,
  allowHarnessRuns: boolean,
  requireFullYear = false,
): BacktestRunRef | null {
  const harnessModelSelect = getHarnessModelSelect(capabilities)
  const fullYearClause = requireFullYear
    ? "AND sim_start IS NOT NULL AND sim_end IS NOT NULL AND julianday(sim_end) - julianday(sim_start) >= 364"
    : ""
  const harnessRun = capabilities.hasRunsTable && allowHarnessRuns
    ? db.prepare(
        `SELECT id,
                harness,
                ${harnessModelSelect},
                sim_start as simStart,
                sim_end as simEnd,
                completed_at as completedAt
         FROM runs
         WHERE bot_id = ? AND mode = 'backtest' AND status = 'completed' ${fullYearClause}
         ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
          LIMIT 1`
      ).get(botId) as {
        id: number
        harness: string
        model: string | null
        simStart: string | null
        simEnd: string | null
        completedAt: string | null
      } | undefined
    : undefined

  const legacyRun = capabilities.hasBacktestRunsTable
    ? db.prepare(
        `SELECT id,
                sim_start as simStart,
                sim_end as simEnd,
                completed_at as completedAt
         FROM backtest_runs
         WHERE bot_id = ? AND status = 'completed' ${fullYearClause}
         ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
         LIMIT 1`
      ).get(botId) as {
        id: number
        simStart: string | null
        simEnd: string | null
        completedAt: string | null
      } | undefined
    : undefined

  if (!harnessRun && !legacyRun) return null
  if (!legacyRun) {
    return {
      id: harnessRun!.id,
      source: "harness",
      mode: "backtest",
      harness: harnessRun!.harness,
      model: normalizeRunModel(harnessRun!.model),
      simStart: harnessRun!.simStart,
      simEnd: harnessRun!.simEnd,
      completedAt: harnessRun!.completedAt,
      isFullYear: isFullYearRun(harnessRun!.simStart, harnessRun!.simEnd),
    }
  }
  if (!harnessRun) {
    return {
      id: legacyRun.id,
      source: "legacy",
      mode: "backtest",
      harness: null,
      model: null,
      simStart: legacyRun.simStart,
      simEnd: legacyRun.simEnd,
      completedAt: legacyRun.completedAt,
      isFullYear: isFullYearRun(legacyRun.simStart, legacyRun.simEnd),
    }
  }

  const harnessTime = harnessRun.completedAt ? Date.parse(harnessRun.completedAt) : 0
  const legacyTime = legacyRun.completedAt ? Date.parse(legacyRun.completedAt) : 0

  if (harnessTime !== legacyTime) {
    return harnessTime > legacyTime
      ? {
          id: harnessRun.id,
          source: "harness",
          mode: "backtest",
          harness: harnessRun.harness,
          model: normalizeRunModel(harnessRun.model),
          simStart: harnessRun.simStart,
          simEnd: harnessRun.simEnd,
          completedAt: harnessRun.completedAt,
          isFullYear: isFullYearRun(harnessRun.simStart, harnessRun.simEnd),
        }
      : {
          id: legacyRun.id,
          source: "legacy",
          mode: "backtest",
          harness: null,
          model: null,
          simStart: legacyRun.simStart,
          simEnd: legacyRun.simEnd,
          completedAt: legacyRun.completedAt,
          isFullYear: isFullYearRun(legacyRun.simStart, legacyRun.simEnd),
        }
  }

  return harnessRun.id >= legacyRun.id
    ? {
        id: harnessRun.id,
        source: "harness",
        mode: "backtest",
        harness: harnessRun.harness,
        model: normalizeRunModel(harnessRun.model),
        simStart: harnessRun.simStart,
        simEnd: harnessRun.simEnd,
        completedAt: harnessRun.completedAt,
        isFullYear: isFullYearRun(harnessRun.simStart, harnessRun.simEnd),
      }
    : {
        id: legacyRun.id,
        source: "legacy",
        mode: "backtest",
        harness: null,
        model: null,
        simStart: legacyRun.simStart,
        simEnd: legacyRun.simEnd,
        completedAt: legacyRun.completedAt,
        isFullYear: isFullYearRun(legacyRun.simStart, legacyRun.simEnd),
      }
}

function getLatestRealtimeRun(
  db: Database,
  capabilities: DbSchemaCapabilities,
  botId: string,
  mode: "paper" | "live",
): RunMeta | null {
  if (!capabilities.hasRunsTable) return null

  const row = db.prepare(
    `SELECT id,
            harness,
            ${getHarnessModelSelect(capabilities)},
            completed_at as completedAt
     FROM runs
     WHERE bot_id = ? AND mode = ?
     ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
     LIMIT 1`
  ).get(botId, mode) as {
    id: number
    harness: string
    model: string | null
    completedAt: string | null
  } | undefined

  if (!row) return null

  return {
    id: row.id,
    source: "harness",
    mode,
    harness: row.harness,
    model: normalizeRunModel(row.model),
    simStart: null,
    simEnd: null,
    completedAt: row.completedAt,
    isFullYear: false,
  }
}

function getNonBacktestWhere(tableAlias: "d" | "p" = "p"): string {
  return `${tableAlias}.backtest_run_id IS NULL AND (r.mode IS NULL OR r.mode != 'backtest')`
}

function calculatePercentReturn(currentValue: number | null, startingValue: number | null): number | null {
  if (currentValue == null || startingValue == null || startingValue === 0) {
    return null
  }

  return ((currentValue - startingValue) / startingValue) * 100
}

export function getAllBotSummaries(botIds: string[], mode: AppMode): BotSummary[] {
  const db = getDb(mode)
  if (!db) {
    return botIds.map((botId) => ({
      id: botId,
      name: botId,
      description: "",
        enabled: true,
        cron: "",
        model: "",
        latestPnl: null,
        lastDecision: null,
        totalReturn: null,
        spyReturn: null,
        returnVsSpy: null,
        totalDecisions: 0,
        runMeta: null,
      }))
  }

  const capabilities = getSchemaCapabilities(mode, db)

  return botIds.map((botId) => {
    let latestPnl: PnlSnapshot | null = null
    let firstPnl: PnlSnapshot | null = null
    let lastDecision: Decision | null = null
    let totalDecisions = 0
    let runMeta: RunMeta | null = null

    if (mode === "backtesting") {
      const latestRun = getLatestBacktestRun(
        db,
        capabilities,
        botId,
        capabilities.hasRunsTable && capabilities.decisionsHasRunId && capabilities.pnlHasRunId,
      )
      runMeta = latestRun
      if (latestRun?.source === "harness") {
        latestPnl = (db.prepare(
          "SELECT * FROM pnl_snapshots WHERE run_id = ? ORDER BY sim_date DESC, timestamp DESC LIMIT 1"
        ).get(latestRun.id) as PnlSnapshot | undefined) ?? null

        firstPnl = (db.prepare(
          "SELECT * FROM pnl_snapshots WHERE run_id = ? ORDER BY sim_date ASC, timestamp ASC LIMIT 1"
        ).get(latestRun.id) as PnlSnapshot | undefined) ?? null

        lastDecision = (db.prepare(
          "SELECT * FROM decisions WHERE run_id = ? ORDER BY sim_date DESC, timestamp DESC LIMIT 1"
        ).get(latestRun.id) as Decision | undefined) ?? null

        const row = db.prepare(
          "SELECT COUNT(*) as count FROM decisions WHERE run_id = ?"
        ).get(latestRun.id) as { count: number } | undefined
        totalDecisions = row?.count ?? 0
      } else if (latestRun?.source === "legacy") {
        latestPnl = (db.prepare(
          "SELECT * FROM pnl_snapshots WHERE backtest_run_id = ? ORDER BY sim_date DESC, timestamp DESC LIMIT 1"
        ).get(latestRun.id) as PnlSnapshot | undefined) ?? null

        firstPnl = (db.prepare(
          "SELECT * FROM pnl_snapshots WHERE backtest_run_id = ? ORDER BY sim_date ASC, timestamp ASC LIMIT 1"
        ).get(latestRun.id) as PnlSnapshot | undefined) ?? null

        lastDecision = (db.prepare(
          "SELECT * FROM decisions WHERE backtest_run_id = ? ORDER BY sim_date DESC, timestamp DESC LIMIT 1"
        ).get(latestRun.id) as Decision | undefined) ?? null

        const row = db.prepare(
          "SELECT COUNT(*) as count FROM decisions WHERE backtest_run_id = ?"
        ).get(latestRun.id) as { count: number } | undefined
        totalDecisions = row?.count ?? 0
      }
    } else {
      runMeta = getLatestRealtimeRun(db, capabilities, botId, mode)
      if (capabilities.hasRunsTable && capabilities.pnlHasRunId) {
        latestPnl = (db.prepare(
          `SELECT p.*
           FROM pnl_snapshots p
           LEFT JOIN runs r ON p.run_id = r.id
           WHERE p.bot_id = ? AND ${getNonBacktestWhere("p")}
           ORDER BY p.timestamp DESC
           LIMIT 1`
        ).get(botId) as PnlSnapshot | undefined) ?? null

        firstPnl = (db.prepare(
          `SELECT p.*
           FROM pnl_snapshots p
           LEFT JOIN runs r ON p.run_id = r.id
           WHERE p.bot_id = ? AND ${getNonBacktestWhere("p")}
           ORDER BY p.timestamp ASC
           LIMIT 1`
        ).get(botId) as PnlSnapshot | undefined) ?? null
      } else {
        latestPnl = (db.prepare(
          "SELECT * FROM pnl_snapshots WHERE bot_id = ? AND backtest_run_id IS NULL ORDER BY timestamp DESC LIMIT 1"
        ).get(botId) as PnlSnapshot | undefined) ?? null

        firstPnl = (db.prepare(
          "SELECT * FROM pnl_snapshots WHERE bot_id = ? AND backtest_run_id IS NULL ORDER BY timestamp ASC LIMIT 1"
        ).get(botId) as PnlSnapshot | undefined) ?? null
      }

      if (capabilities.hasRunsTable && capabilities.decisionsHasRunId) {
        lastDecision = (db.prepare(
          `SELECT d.*
           FROM decisions d
           LEFT JOIN runs r ON d.run_id = r.id
           WHERE d.bot_id = ? AND ${getNonBacktestWhere("d")}
           ORDER BY d.timestamp DESC
           LIMIT 1`
        ).get(botId) as Decision | undefined) ?? null

        const row = db.prepare(
          `SELECT COUNT(*) as count
           FROM decisions d
           LEFT JOIN runs r ON d.run_id = r.id
           WHERE d.bot_id = ? AND ${getNonBacktestWhere("d")}`
        ).get(botId) as { count: number } | undefined
        totalDecisions = row?.count ?? 0
      } else {
        lastDecision = (db.prepare(
          "SELECT * FROM decisions WHERE bot_id = ? AND backtest_run_id IS NULL ORDER BY timestamp DESC LIMIT 1"
        ).get(botId) as Decision | undefined) ?? null

        const row = db.prepare(
          "SELECT COUNT(*) as count FROM decisions WHERE bot_id = ? AND backtest_run_id IS NULL"
        ).get(botId) as { count: number } | undefined
        totalDecisions = row?.count ?? 0
      }
    }

    const totalReturn = calculatePercentReturn(
      latestPnl?.portfolio_value ?? null,
      firstPnl?.portfolio_value ?? null,
    )
    const spyReturn = calculatePercentReturn(
      latestPnl?.spy_value ?? null,
      firstPnl?.spy_value ?? null,
    )
    const returnVsSpy =
      totalReturn != null && spyReturn != null
        ? totalReturn - spyReturn
        : null

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
      spyReturn,
      returnVsSpy,
      totalDecisions,
      runMeta,
    }
  })
}

export function getPnlHistory(botId: string, mode: AppMode, limit = 500): PnlSnapshot[] {
  const db = getDb(mode)
  if (!db) return []
  const capabilities = getSchemaCapabilities(mode, db)

  if (mode === "backtesting") {
    const latestRun = getLatestBacktestRun(
      db,
      capabilities,
      botId,
      capabilities.hasRunsTable && capabilities.pnlHasRunId,
    )
    if (latestRun?.source === "harness") {
      return db.prepare(
        "SELECT * FROM pnl_snapshots WHERE run_id = ? ORDER BY sim_date ASC, timestamp ASC LIMIT ?"
      ).all(latestRun.id, limit) as PnlSnapshot[]
    }

    if (latestRun?.source === "legacy") {
      return db.prepare(
        "SELECT * FROM pnl_snapshots WHERE backtest_run_id = ? ORDER BY sim_date ASC, timestamp ASC LIMIT ?"
      ).all(latestRun.id, limit) as PnlSnapshot[]
    }

    return []
  }

  if (capabilities.hasRunsTable && capabilities.pnlHasRunId) {
    return db.prepare(
      `SELECT p.*
       FROM pnl_snapshots p
       LEFT JOIN runs r ON p.run_id = r.id
       WHERE p.bot_id = ? AND ${getNonBacktestWhere("p")}
       ORDER BY p.timestamp ASC
       LIMIT ?`
    ).all(botId, limit) as PnlSnapshot[]
  }

  return db.prepare(
    "SELECT * FROM pnl_snapshots WHERE bot_id = ? AND backtest_run_id IS NULL ORDER BY timestamp ASC LIMIT ?"
  ).all(botId, limit) as PnlSnapshot[]
}

function getPnlHistoryForRun(db: Database, run: BacktestRunRef, limit: number): PnlSnapshot[] {
  if (run.source === "harness") {
    return db.prepare(
      "SELECT * FROM pnl_snapshots WHERE run_id = ? ORDER BY sim_date ASC, timestamp ASC LIMIT ?"
    ).all(run.id, limit) as PnlSnapshot[]
  }

  return db.prepare(
    "SELECT * FROM pnl_snapshots WHERE backtest_run_id = ? ORDER BY sim_date ASC, timestamp ASC LIMIT ?"
  ).all(run.id, limit) as PnlSnapshot[]
}

export function getBacktestComparisonSeries(botId: string, limit = 500): {
  runMeta: RunMeta | null
  history: PnlSnapshot[]
} {
  const db = getDb("backtesting")
  if (!db) {
    return { runMeta: null, history: [] }
  }

  const capabilities = getSchemaCapabilities("backtesting", db)
  const run = getLatestBacktestRun(
    db,
    capabilities,
    botId,
    capabilities.hasRunsTable && capabilities.pnlHasRunId,
    true,
  )

  if (!run) {
    return { runMeta: null, history: [] }
  }

  return {
    runMeta: run,
    history: getPnlHistoryForRun(db, run, limit),
  }
}

export function getDecisions(botId: string, mode: AppMode, limit = 50): Decision[] {
  const db = getDb(mode)
  if (!db) return []
  const capabilities = getSchemaCapabilities(mode, db)

  if (mode === "backtesting") {
    const latestRun = getLatestBacktestRun(
      db,
      capabilities,
      botId,
      capabilities.hasRunsTable && capabilities.decisionsHasRunId,
    )
    if (latestRun?.source === "harness") {
      return db.prepare(
        "SELECT * FROM decisions WHERE run_id = ? ORDER BY sim_date DESC, timestamp DESC LIMIT ?"
      ).all(latestRun.id, limit) as Decision[]
    }

    if (latestRun?.source === "legacy") {
      return db.prepare(
        "SELECT * FROM decisions WHERE backtest_run_id = ? ORDER BY sim_date DESC, timestamp DESC LIMIT ?"
      ).all(latestRun.id, limit) as Decision[]
    }

    return []
  }

  if (capabilities.hasRunsTable && capabilities.decisionsHasRunId) {
    return db.prepare(
      `SELECT d.*
       FROM decisions d
       LEFT JOIN runs r ON d.run_id = r.id
       WHERE d.bot_id = ? AND ${getNonBacktestWhere("d")}
       ORDER BY d.timestamp DESC
       LIMIT ?`
    ).all(botId, limit) as Decision[]
  }

  return db.prepare(
    "SELECT * FROM decisions WHERE bot_id = ? AND backtest_run_id IS NULL ORDER BY timestamp DESC LIMIT ?"
  ).all(botId, limit) as Decision[]
}
