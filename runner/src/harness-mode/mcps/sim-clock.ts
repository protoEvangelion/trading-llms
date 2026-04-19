#!/usr/bin/env bun
/**
 * Sim Clock MCP Server
 *
 * Owns the simulation clock for the entire harness run. All date-sensitive MCPs
 * read from the same state file so advancing the day takes effect globally without
 * restarting any process.
 *
 * Required env:
 *   SIM_CLOCK_STATE_FILE  — path to JSON clock state
 *
 * Optional env:
 *   BACKTEST_STATE_FILE   — if set, advance_to_next_trading_day also updates simDate there
 *   HARNESS_LOG_FILE      — markdown file to append log_decision entries
 */

import { z } from "zod"
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { dirname } from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { getDb, logPnlSnapshot } from "../../db.js"
import { calculatePortfolioValue, getClosePrice } from "../../simulation.js"

const CLOCK_FILE = process.env.SIM_CLOCK_STATE_FILE
const BACKTEST_STATE_FILE = process.env.BACKTEST_STATE_FILE ?? null
const LOG_FILE = process.env.HARNESS_LOG_FILE ?? null
const ALPACA_KEY = process.env.ALPACA_KEY ?? null
const ALPACA_SECRET = process.env.ALPACA_SECRET ?? null

const DEFAULT_STARTING_CASH = 100_000

export interface SimClockState {
  runId: number
  mode: "backtest" | "paper" | "live"
  tradingDays: string[]
  currentDayIndex: number
  completed: boolean
}

interface HarnessBacktestState {
  runId: number
  botId: string
  simDate: string
  cash: number
  startingCash?: number
  positions: Record<string, { qty: number; costBasis: number }>
  orders: Array<{
    date: string
    symbol: string
    side: "buy" | "sell"
    dollarAmount: number
    fillPrice: number
    qty: number
  }>
}

function requireClockFile(): string {
  if (!CLOCK_FILE) throw new Error("SIM_CLOCK_STATE_FILE env var required")
  return CLOCK_FILE
}

export function readSimClockState(stateFile = requireClockFile()): SimClockState {
  return JSON.parse(readFileSync(stateFile, "utf8")) as SimClockState
}

export function readSimDate(stateFile = process.env.SIM_CLOCK_STATE_FILE ?? null): string | null {
  if (!stateFile) return null
  try {
    const state = readSimClockState(stateFile)
    return state.tradingDays[state.currentDayIndex] ?? null
  } catch {
    return null
  }
}

function readClock(): SimClockState {
  return readSimClockState(requireClockFile())
}

function writeClock(state: SimClockState): void {
  writeFileSync(requireClockFile(), JSON.stringify(state, null, 2), "utf8")
}

function readBacktestState(): HarnessBacktestState {
  if (!BACKTEST_STATE_FILE) throw new Error("BACKTEST_STATE_FILE env var required in backtest mode")
  return JSON.parse(readFileSync(BACKTEST_STATE_FILE, "utf8")) as HarnessBacktestState
}

function syncBacktestStateDate(newDate: string): void {
  if (!BACKTEST_STATE_FILE) return
  try {
    const state = readBacktestState()
    state.simDate = newDate
    writeFileSync(BACKTEST_STATE_FILE, JSON.stringify(state, null, 2), "utf8")
  } catch (err) {
    console.error("[sim-clock] Failed to sync backtest simDate:", err)
  }
}

async function recordDailySnapshot(clockState: SimClockState, currentDate: string): Promise<void> {
  if (!BACKTEST_STATE_FILE) return
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    throw new Error("ALPACA_KEY / ALPACA_SECRET env vars are required for backtest snapshots")
  }

  const state = readBacktestState()
  const db = getDb()
  const existing = db
    .query<{ id: number }, [number, string]>(
      `SELECT id FROM pnl_snapshots WHERE run_id = ? AND sim_date = ? LIMIT 1`,
    )
    .get(state.runId, currentDate)

  if (existing) return

  const portfolioValue = await calculatePortfolioValue(state, currentDate, ALPACA_KEY, ALPACA_SECRET)

  let spyValue: number | undefined
  const startDate = clockState.tradingDays[0]
  if (startDate) {
    const spyStart = await getClosePrice("SPY", startDate, ALPACA_KEY, ALPACA_SECRET)
    const spyClose = await getClosePrice("SPY", currentDate, ALPACA_KEY, ALPACA_SECRET)
    const startingCash = state.startingCash ?? DEFAULT_STARTING_CASH
    spyValue = (spyClose / spyStart) * startingCash
  }

  logPnlSnapshot({
    botId: state.botId,
    mode: "backtest",
    runId: state.runId,
    simDate: currentDate,
    portfolioValue,
    cash: state.cash,
    positions: state.positions,
    spyValue,
  })
}

function currentEtInfo(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(now)

  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""
  const hour = parseInt(value("hour"), 10)
  const minute = parseInt(value("minute"), 10)
  const weekday = value("weekday")
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)
  const minutesSinceMidnight = hour * 60 + minute
  const marketOpen = isWeekday && minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight < 16 * 60

  return {
    datetime: `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}`,
    timezone: "America/New_York",
    marketOpen,
    utc: now.toISOString(),
  }
}

function createServer() {
  const server = new McpServer({ name: "sim-clock", version: "1.0.0" })

  server.tool(
    "get_sim_state",
    "Get the current simulation date and backtest progress. Call this at the start of each day.",
    {},
    async () => {
      const state = readClock()
      if (state.mode !== "backtest") {
        return { content: [{ type: "text", text: JSON.stringify({ mode: state.mode, message: "Live/paper mode — use get_current_time() for wall clock." }) }] }
      }
      const currentDate = state.tradingDays[state.currentDayIndex] ?? null
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            currentDate,
            dayNumber: state.currentDayIndex + 1,
            totalDays: state.tradingDays.length,
            daysRemaining: state.tradingDays.length - state.currentDayIndex - 1,
            completed: state.completed,
          }),
        }],
      }
    }
  )

  server.tool(
    "advance_to_next_trading_day",
    "Mark the current trading day complete and advance to the next. Returns {done:true} when all days are finished — stop when you receive this.",
    {},
    async () => {
      const state = readClock()
      if (state.mode !== "backtest") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "advance_to_next_trading_day is only valid in backtest mode" }) }] }
      }

      const currentDate = state.tradingDays[state.currentDayIndex]
      if (!currentDate) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No current trading day is available in sim-clock state" }) }] }
      }

      try {
        await recordDailySnapshot(state, currentDate)
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Failed to record end-of-day snapshot for ${currentDate}: ${err instanceof Error ? err.message : String(err)}` }),
          }],
        }
      }

      const nextIndex = state.currentDayIndex + 1
      if (nextIndex >= state.tradingDays.length) {
        state.completed = true
        writeClock(state)
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ done: true, message: `Backtest complete — all ${state.tradingDays.length} trading days simulated.` }),
          }],
        }
      }

      state.currentDayIndex = nextIndex
      writeClock(state)
      const newDate = state.tradingDays[nextIndex]
      syncBacktestStateDate(newDate)
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: newDate,
            dayNumber: nextIndex + 1,
            daysRemaining: state.tradingDays.length - nextIndex - 1,
          }),
        }],
      }
    }
  )

  server.tool(
    "get_trading_calendar",
    "Get the full list of trading days for this backtest run.",
    {},
    async () => {
      const state = readClock()
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ days: state.tradingDays, total: state.tradingDays.length, currentIndex: state.currentDayIndex }),
        }],
      }
    }
  )

  server.tool(
    "get_current_time",
    "Get the current real-world time in US Eastern timezone. Use for paper/live mode to check market hours.",
    {},
    async () => ({ content: [{ type: "text", text: JSON.stringify(currentEtInfo()) }] })
  )

  server.tool(
    "log_decision",
    "Append your trading decision and reasoning to the run log. Call this after every buy, sell, or hold decision.",
    {
      text: z.string().describe("Markdown-formatted decision entry — include date, action, symbol, amount, and your reasoning"),
    },
    async ({ text }) => {
      if (!LOG_FILE) return { content: [{ type: "text", text: "No log file configured — decision not persisted." }] }
      try {
        mkdirSync(dirname(LOG_FILE), { recursive: true })
        const ts = new Date().toISOString().slice(0, 19).replace("T", " ")
        appendFileSync(LOG_FILE, `\n---\n_${ts}_\n\n${text}\n`, "utf8")
        return { content: [{ type: "text", text: "Decision logged." }] }
      } catch (err) {
        return { content: [{ type: "text", text: `Log write failed: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  return server
}

if (import.meta.main) {
  const transport = new StdioServerTransport()
  await createServer().connect(transport)
}
