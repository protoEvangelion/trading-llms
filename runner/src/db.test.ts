import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"
import {
  _resetDb,
  clearPositionReasons,
  getDb,
  getPositionReasons,
  hasSeenContent,
  logDecision,
  logPnlSnapshot,
  markContentSeen,
  upsertPositionReason,
} from "./db.js"

const TEST_DIR = "/tmp/trading-bots-test"

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env.TRADING_BOTS_DATA_DIR = TEST_DIR
  process.env.TRADING_ENV = "test"
  _resetDb()
})

afterEach(() => {
  _resetDb()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe("schema", () => {
  test("migrate creates all required tables", () => {
    const db = getDb()
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain("decisions")
    expect(names).toContain("pnl_snapshots")
    expect(names).toContain("position_reasons")
    expect(names).toContain("seen_content")
    expect(names).toContain("backtest_runs")
    expect(names).toContain("runs")
    // Legacy table should be gone
    expect(names).not.toContain("position_theses")
  })

  test("migrate adds harness run foreign keys to decision and pnl tables", () => {
    const db = getDb()
    const decisionColumns = db.query("PRAGMA table_info(decisions)").all() as Array<{ name: string }>
    const pnlColumns = db.query("PRAGMA table_info(pnl_snapshots)").all() as Array<{ name: string }>
    const runColumns = db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>

    expect(decisionColumns.map((column) => column.name)).toContain("run_id")
    expect(pnlColumns.map((column) => column.name)).toContain("run_id")
    expect(runColumns.map((column) => column.name)).toContain("model")
  })
})

describe("seen_content", () => {
  test("marks and checks content as seen", () => {
    expect(hasSeenContent("bot-1", "post-abc")).toBe(false)
    markContentSeen("bot-1", "post-abc")
    expect(hasSeenContent("bot-1", "post-abc")).toBe(true)
  })

  test("is scoped per bot", () => {
    markContentSeen("bot-1", "post-abc")
    expect(hasSeenContent("bot-2", "post-abc")).toBe(false)
  })
})

describe("position_reasons", () => {
  test("upsert and retrieve", () => {
    upsertPositionReason({ botId: "bot-1", symbol: "AAPL", reason: "strong buy signal", entryAmount: 10_000 })
    const reasons = getPositionReasons("bot-1")
    expect(reasons).toHaveLength(1)
    expect(reasons[0].symbol).toBe("AAPL")
    expect(reasons[0].reason).toBe("strong buy signal")
  })

  test("upsert overwrites existing reason", () => {
    upsertPositionReason({ botId: "bot-1", symbol: "AAPL", reason: "first reason", entryAmount: 10_000 })
    upsertPositionReason({ botId: "bot-1", symbol: "AAPL", reason: "updated reason", entryAmount: 15_000 })
    const reasons = getPositionReasons("bot-1")
    expect(reasons).toHaveLength(1)
    expect(reasons[0].reason).toBe("updated reason")
  })

  test("clearPositionReasons removes all for bot", () => {
    upsertPositionReason({ botId: "bot-1", symbol: "AAPL", reason: "r1", entryAmount: 1_000 })
    upsertPositionReason({ botId: "bot-1", symbol: "TSLA", reason: "r2", entryAmount: 2_000 })
    clearPositionReasons("bot-1")
    expect(getPositionReasons("bot-1")).toHaveLength(0)
  })
})

describe("logDecision", () => {
  test("inserts a decision row", () => {
    logDecision({
      botId: "bot-1",
      reasoning: "test reasoning",
      action: "do_nothing",
      symbol: undefined,
      amount: undefined,
      toolCalls: [],
    })
    const db = getDb()
    const row = db.query("SELECT * FROM decisions WHERE bot_id = 'bot-1'").get() as { action: string }
    expect(row.action).toBe("do_nothing")
  })

  test("stores harness run_id when provided", () => {
    logDecision({
      botId: "bot-1",
      reasoning: "harness note",
      action: "buy_stock",
      symbol: "AAPL",
      amount: 5_000,
      toolCalls: [],
      runId: 42,
      simDate: "2026-04-10",
    })

    const db = getDb()
    const row = db.query("SELECT run_id, sim_date FROM decisions WHERE bot_id = 'bot-1'").get() as { run_id: number; sim_date: string }
    expect(row.run_id).toBe(42)
    expect(row.sim_date).toBe("2026-04-10")
  })
})

describe("logPnlSnapshot", () => {
  test("stores harness run_id when provided", () => {
    logPnlSnapshot({
      botId: "bot-1",
      runId: 99,
      simDate: "2026-04-10",
      portfolioValue: 123_456,
      cash: 12_345,
      positions: { AAPL: { qty: 1, costBasis: 100 } },
      spyValue: 101_000,
    })

    const db = getDb()
    const row = db
      .query("SELECT run_id, sim_date, portfolio_value FROM pnl_snapshots WHERE bot_id = 'bot-1'")
      .get() as { run_id: number; sim_date: string; portfolio_value: number }

    expect(row.run_id).toBe(99)
    expect(row.sim_date).toBe("2026-04-10")
    expect(row.portfolio_value).toBe(123_456)
  })
})
