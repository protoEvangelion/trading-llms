/**
 * Simulation helpers for backtesting.
 *
 * Handles:
 * - SimulationState: the serializable portfolio state shared via state file
 * - OHLCV helpers: fetch historical prices from Alpaca Data API
 * - Trading calendar: get trading days from Alpaca calendar API
 * - Cron parsing: determine which hours fire on a given day
 */

import { writeFileSync, readFileSync, unlinkSync } from "fs"
import { join } from "path"
import { mkdirSync } from "fs"

// ─── State types ──────────────────────────────────────────────────────────────

export interface SimPosition {
  qty: number
  costBasis: number  // average cost per share
}

export interface SimOrder {
  date: string
  symbol: string
  side: "buy" | "sell"
  dollarAmount: number
  fillPrice: number
  qty: number
}

export interface SimState {
  runId: number
  botId: string
  simDate: string  // YYYY-MM-DD
  cash: number
  positions: Record<string, SimPosition>
  orders: SimOrder[]
}

// ─── State file I/O ───────────────────────────────────────────────────────────

export function writeSimState(filePath: string, state: SimState): void {
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8")
}

export function readSimState(filePath: string): SimState {
  return JSON.parse(readFileSync(filePath, "utf8")) as SimState
}

export function deleteSimStateFile(filePath: string): void {
  try { unlinkSync(filePath) } catch {}
}

export function makeStateFilePath(dataDir: string, runId: number): string {
  mkdirSync(dataDir, { recursive: true })
  return join(dataDir, `backtest-state-${runId}.json`)
}

// ─── Alpaca Data API ──────────────────────────────────────────────────────────

/**
 * Alpaca free tier blocks SIP queries where end >= yesterday (relative to now).
 * Cap the end param to min(desired end, the start date + offset) so we never
 * send a window that bleeds into "recent" territory.
 * The safest cap is the query date itself — data for that date is available
 * as long as end === that date exactly.
 */
export function capEnd(desiredEnd: string, queryDate: string): string {
  return desiredEnd > queryDate ? queryDate : desiredEnd
}

const ALPACA_DATA_BASE = "https://data.alpaca.markets"

interface BarData {
  o: number
  h: number
  l: number
  c: number
  v: number
  t: string
}

interface BarsResponse {
  bars: Record<string, BarData[]>
}

interface CalendarDay {
  date: string
  open: string
  close: string
}

function alpacaHeaders(key: string, secret: string): Record<string, string> {
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
    Accept: "application/json",
  }
}

/**
 * Fetch historical daily bar data for one or more symbols.
 * Returns a map of symbol → bars array.
 */
export async function getHistoricalBars(
  symbols: string[],
  start: string,  // YYYY-MM-DD
  end: string,    // YYYY-MM-DD
  key: string,
  secret: string,
): Promise<Record<string, BarData[]>> {
  const url = new URL(`${ALPACA_DATA_BASE}/v2/stocks/bars`)
  url.searchParams.set("symbols", symbols.map((s) => s.toUpperCase()).join(","))
  url.searchParams.set("timeframe", "1Day")
  url.searchParams.set("start", start)
  url.searchParams.set("end", end)
  url.searchParams.set("limit", "1000")
  url.searchParams.set("feed", "sip")
  url.searchParams.set("adjustment", "split")

  const res = await fetch(url.toString(), { headers: alpacaHeaders(key, secret) })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Alpaca bars API ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as BarsResponse
  return data.bars ?? {}
}

/**
 * Get the open price for a symbol on a given date.
 * Tries up to 3 days forward to skip non-trading days.
 */
export async function getOpenPrice(
  symbol: string,
  date: string,
  key: string,
  secret: string,
): Promise<number> {
  const endDate = new Date(date)
  endDate.setDate(endDate.getDate() + 4)
  const end = capEnd(endDate.toISOString().slice(0, 10), date)
  const bars = await getHistoricalBars([symbol], date, end, key, secret)
  const symbolBars = bars[symbol.toUpperCase()]
  if (!symbolBars || symbolBars.length === 0) {
    throw new Error(`No bar data for ${symbol} from ${date}`)
  }
  return symbolBars[0].o
}

/**
 * Get the close price for a symbol on a given date.
 */
export async function getClosePrice(
  symbol: string,
  date: string,
  key: string,
  secret: string,
): Promise<number> {
  const endDate = new Date(date)
  endDate.setDate(endDate.getDate() + 4)
  const end = capEnd(endDate.toISOString().slice(0, 10), date)
  const bars = await getHistoricalBars([symbol], date, end, key, secret)
  const symbolBars = bars[symbol.toUpperCase()]
  if (!symbolBars || symbolBars.length === 0) {
    throw new Error(`No bar data for ${symbol} from ${date}`)
  }
  return symbolBars[0].c
}

/**
 * Calculate current portfolio value using close prices for all held positions.
 */
export async function calculatePortfolioValue(
  state: SimState,
  date: string,
  key: string,
  secret: string,
): Promise<number> {
  if (Object.keys(state.positions).length === 0) return state.cash

  const symbols = Object.keys(state.positions)
  const endDate = new Date(date)
  endDate.setDate(endDate.getDate() + 4)
  const end = capEnd(endDate.toISOString().slice(0, 10), date)

  let bars: Record<string, BarData[]> = {}
  try {
    bars = await getHistoricalBars(symbols, date, end, key, secret)
  } catch (err) {
    console.warn(`[simulation] Price fetch failed for ${symbols.join(",")} on ${date}, falling back to cost basis: ${err instanceof Error ? err.message : String(err)}`)
  }

  let equityValue = 0
  for (const [sym, pos] of Object.entries(state.positions)) {
    const symBars = bars[sym.toUpperCase()]
    const price = symBars && symBars.length > 0 ? symBars[0].c : pos.costBasis
    equityValue += pos.qty * price
  }

  return state.cash + equityValue
}

// ─── Trading calendar ─────────────────────────────────────────────────────────

/**
 * Get trading days between start and end (inclusive) using Alpaca calendar API.
 */
export async function getTradingDays(
  start: string,
  end: string,
  key: string,
  secret: string,
): Promise<string[]> {
  const url = new URL("https://paper-api.alpaca.markets/v2/calendar")
  url.searchParams.set("start", start)
  url.searchParams.set("end", end)

  const res = await fetch(url.toString(), { headers: alpacaHeaders(key, secret) })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Alpaca calendar API ${res.status}: ${text.slice(0, 200)}`)
  }

  const days = await res.json() as CalendarDay[]
  return days.map((d) => d.date)
}

// ─── Cron helpers ─────────────────────────────────────────────────────────────

// Parse the hour field of a 5-field cron expression to get which hours fire.
// Supports: "*", "* /N" (step), "H,H,H" (list), "H-H" (range).
// Always returns hours sorted ascending.
// Examples:
//   "0 */4 * * 1-5"            -> [0, 4, 8, 12, 16, 20]
//   "45 3,7,11,15,19 * * 1-5"  -> [3, 7, 11, 15, 19]
//   "0 10 * * 1-5"             -> [10]
export function getCronHours(cronExpression: string): number[] {
  const parts = cronExpression.trim().split(/\s+/)
  if (parts.length !== 5) return [9]  // fallback: 9am

  const hourField = parts[1]
  const hours = new Set<number>()

  if (hourField === "*") {
    for (let h = 0; h < 24; h++) hours.add(h)
  } else if (hourField.startsWith("*/")) {
    const step = parseInt(hourField.slice(2))
    for (let h = 0; h < 24; h += step) hours.add(h)
  } else if (hourField.includes(",")) {
    for (const h of hourField.split(",")) hours.add(parseInt(h))
  } else if (hourField.includes("-")) {
    const [start, end] = hourField.split("-").map(Number)
    for (let h = start; h <= end; h++) hours.add(h)
  } else {
    hours.add(parseInt(hourField))
  }

  return [...hours].filter((h) => !isNaN(h)).sort((a, b) => a - b)
}

/**
 * Parse the minute field of a cron expression.
 * Returns the first minute value (for simplicity).
 */
export function getCronMinute(cronExpression: string): number {
  const parts = cronExpression.trim().split(/\s+/)
  if (parts.length !== 5) return 0
  const minuteField = parts[0]
  if (minuteField === "*") return 0
  if (minuteField.startsWith("*/")) return 0
  if (minuteField.includes(",")) return parseInt(minuteField.split(",")[0])
  return parseInt(minuteField) || 0
}

/**
 * Build a list of simulated datetime strings (ET) for a given trading day,
 * based on the bot's cron schedule.
 *
 * Returns strings like "2025-04-07T09:45:00"
 */
export function getSimDateTimes(tradingDay: string, cronExpression: string): string[] {
  const hours = getCronHours(cronExpression)
  const minute = getCronMinute(cronExpression)
  const minuteStr = String(minute).padStart(2, "0")
  return hours.map((h) => `${tradingDay}T${String(h).padStart(2, "0")}:${minuteStr}:00`)
}

/**
 * Convert "YYYY-MM-DDTHH:MM:SS" expressed in US Eastern Time to a UTC ISO string.
 * Simplified rule: months 4–10 = EDT (UTC-4), otherwise EST (UTC-5).
 */
export function etToUTC(simDateTime: string): string {
  const month = parseInt(simDateTime.slice(5, 7), 10)
  const offsetHours = month >= 4 && month <= 10 ? 4 : 5
  const d = new Date(simDateTime + "Z")
  d.setUTCHours(d.getUTCHours() + offsetHours)
  return d.toISOString()
}

export function getMarketOpenUtc(simDate: string): string {
  return etToUTC(`${simDate}T09:30:00`)
}

// ─── Max drawdown ─────────────────────────────────────────────────────────────

/**
 * Calculate maximum drawdown from a series of portfolio values.
 * Returns a positive number representing the worst peak-to-trough decline
 * as a fraction (e.g. 0.15 = 15% drawdown).
 */
export function calculateMaxDrawdown(values: number[]): number {
  if (values.length < 2) return 0
  let peak = values[0]
  let maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}
