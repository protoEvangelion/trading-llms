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
    // Legacy table should be gone
    expect(names).not.toContain("position_theses")
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
})
