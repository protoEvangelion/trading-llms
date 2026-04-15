#!/usr/bin/env bun
/**
 * Backtest Trade MCP Server
 *
 * Simulates portfolio management and trading using historical Alpaca OHLCV data.
 * Reads and writes a JSON state file (BACKTEST_STATE_FILE env var) instead of
 * calling the Alpaca trading API.
 *
 * Required env vars:
 *   BACKTEST_STATE_FILE  — path to the simulation state JSON file
 *   SIM_DATE             — simulation date (YYYY-MM-DD), used for OHLCV lookup
 *   ALPACA_KEY           — Alpaca API key (for historical data only, no real trades)
 *   ALPACA_SECRET        — Alpaca API secret
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync, writeFileSync } from "fs"
import { getRecentBars } from "../alpaca.js"

const server = new McpServer({
  name: "backtest-trade",
  version: "1.0.0",
})

const STATE_FILE = process.env.BACKTEST_STATE_FILE
const SIM_DATE = process.env.SIM_DATE   // YYYY-MM-DD
const ALPACA_KEY = process.env.ALPACA_KEY
const ALPACA_SECRET = process.env.ALPACA_SECRET

if (!STATE_FILE) throw new Error("BACKTEST_STATE_FILE env var is required")
if (!SIM_DATE) throw new Error("SIM_DATE env var is required")
if (!ALPACA_KEY || !ALPACA_SECRET) throw new Error("ALPACA_KEY / ALPACA_SECRET env vars are required")

// ─── State file helpers ───────────────────────────────────────────────────────

export interface SimPosition {
  qty: number        // fractional shares
  costBasis: number  // avg cost per share
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
  simDate: string
  cash: number
  positions: Record<string, SimPosition>
  orders: SimOrder[]
}

function readState(): SimState {
  return JSON.parse(readFileSync(STATE_FILE!, "utf8")) as SimState
}

function writeState(state: SimState): void {
  writeFileSync(STATE_FILE!, JSON.stringify(state, null, 2), "utf8")
}

// ─── Alpaca Data API (historical OHLCV) ───────────────────────────────────────

const ALPACA_DATA_BASE = "https://data.alpaca.markets"

interface BarData {
  o: number  // open
  h: number  // high
  l: number  // low
  c: number  // close
  v: number  // volume
  t: string  // timestamp
}

interface BarsResponse {
  bars: Record<string, BarData[]>
}

async function getHistoricalOpen(symbol: string, date: string): Promise<number> {
  // end = date itself — Alpaca free tier 403s if end > the query date
  const start = date
  const end = date

  const url = new URL(`${ALPACA_DATA_BASE}/v2/stocks/bars`)
  url.searchParams.set("symbols", symbol.toUpperCase())
  url.searchParams.set("timeframe", "1Day")
  url.searchParams.set("start", start)
  url.searchParams.set("end", end)
  url.searchParams.set("limit", "5")
  url.searchParams.set("feed", "sip")
  url.searchParams.set("adjustment", "split")

  const res = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY!,
      "APCA-API-SECRET-KEY": ALPACA_SECRET!,
      Accept: "application/json",
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Alpaca bars API error ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as BarsResponse
  const bars = data.bars?.[symbol.toUpperCase()]

  if (!bars || bars.length === 0) {
    throw new Error(`No historical price data for ${symbol} on or after ${date}`)
  }

  return bars[0].o  // open price of the first available day
}


async function getHistoricalClose(symbol: string, date: string): Promise<number> {
  // end = date itself — Alpaca free tier 403s if end > the query date
  const url = new URL(`${ALPACA_DATA_BASE}/v2/stocks/bars`)
  url.searchParams.set("symbols", symbol.toUpperCase())
  url.searchParams.set("timeframe", "1Day")
  url.searchParams.set("start", date)
  url.searchParams.set("end", date)
  url.searchParams.set("limit", "2")
  url.searchParams.set("feed", "sip")
  url.searchParams.set("adjustment", "split")

  const res = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY!,
      "APCA-API-SECRET-KEY": ALPACA_SECRET!,
      Accept: "application/json",
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Alpaca bars API error ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as BarsResponse
  const bars = data.bars?.[symbol.toUpperCase()]
  if (!bars || bars.length === 0) throw new Error(`No close price for ${symbol} on ${date}`)
  return bars[0].c
}

// ─── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  "get_market_snapshot",
  "Get SPY (S&P 500) recent performance to gauge overall market regime. Call this first, before any buy/sell decision.",
  {},
  async () => {
    try {
      const end = new Date(SIM_DATE!)
      end.setDate(end.getDate() - 1)
      const start = new Date(end)
      start.setDate(start.getDate() - 12)
      const allBars = await getRecentBars(
        { key: ALPACA_KEY!, secret: ALPACA_SECRET! },
        ["SPY"],
        { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), limit: 6, sort: "desc" },
      )
      const bars = (allBars["SPY"] ?? []).map((b) => ({ date: b.t.slice(0, 10), close: b.c }))
      if (bars.length < 2) return { content: [{ type: "text", text: "Insufficient SPY data available." }] }

      const [d0, d1, ...rest] = bars
      const change1d = ((d0.close - d1.close) / d1.close) * 100
      const d5 = rest[rest.length - 1]
      const change5d = d5 ? ((d0.close - d5.close) / d5.close) * 100 : null

      const regime =
        change1d <= -2 ? "RISK-OFF (SPY down >2% yesterday — defensive bias, avoid new longs)"
        : change1d <= -1 ? "CAUTION (SPY down 1-2% — reduce position sizing)"
        : change1d >= 1 ? "RISK-ON (SPY up >1% — normal sizing)"
        : "NEUTRAL"

      const lines = [
        `[SIMULATION — data as of ${d0.date}]`,
        `SPY: $${d0.close.toFixed(2)}`,
        `1-day: ${change1d >= 0 ? "+" : ""}${change1d.toFixed(2)}%`,
        change5d != null ? `5-day: ${change5d >= 0 ? "+" : ""}${change5d.toFixed(2)}%` : null,
        `Regime: ${regime}`,
      ].filter(Boolean)

      return { content: [{ type: "text", text: lines.join("\n") }] }
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching market snapshot: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.tool(
  "get_portfolio",
  "Get current (simulated) portfolio — cash, equity, positions",
  {},
  async () => {
    try {
      const state = readState()

      // Value positions at previous-close equivalent (open of simDate acts as proxy
      // for pre-market valuation — agent decides before market opens)
      let equityValue = 0
      const positionLines: string[] = []

      for (const [sym, pos] of Object.entries(state.positions)) {
        try {
          const currentPrice = await getHistoricalOpen(sym, state.simDate)
          const marketValue = pos.qty * currentPrice
          equityValue += marketValue
          const unrealizedPl = marketValue - pos.qty * pos.costBasis
          const unrealizedPlPct = ((currentPrice - pos.costBasis) / pos.costBasis * 100).toFixed(2)
          positionLines.push(
            `${sym}: ${pos.qty.toFixed(4)} shares @ avg $${pos.costBasis.toFixed(2)} | ` +
            `current $${currentPrice.toFixed(2)} | ` +
            `P&L: $${unrealizedPl.toFixed(2)} (${unrealizedPlPct}%) | ` +
            `market value: $${marketValue.toFixed(2)}`
          )
        } catch {
          positionLines.push(`${sym}: ${pos.qty.toFixed(4)} shares @ avg $${pos.costBasis.toFixed(2)} | price unavailable`)
        }
      }

      const portfolioValue = state.cash + equityValue
      const positionSummary = positionLines.length > 0
        ? positionLines.join("\n")
        : "No open positions."

      return {
        content: [{
          type: "text",
          text:
            `[SIMULATION — ${state.simDate}]\n` +
            `Portfolio Value: $${portfolioValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}\n` +
            `Cash: $${state.cash.toLocaleString("en-US", { maximumFractionDigits: 2 })}\n` +
            `Equity: $${equityValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}\n` +
            `\nOpen Positions (${Object.keys(state.positions).length}):\n${positionSummary}`,
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error reading simulated portfolio: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  }
)

server.tool(
  "buy_stock",
  "Buy a stock using a dollar amount (simulated fill at market open price for the simulation date)",
  {
    symbol: z.string().describe("Stock ticker symbol"),
    dollar_amount: z.number().positive().describe("Dollar amount to invest"),
    reason: z.string().describe("Your reasoning for this trade"),
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      const state = readState()
      const sym = symbol.toUpperCase()

      if (dollar_amount > state.cash) {
        return {
          content: [{
            type: "text",
            text: `Trade rejected: insufficient cash. You have $${state.cash.toFixed(2)} but tried to spend $${dollar_amount.toFixed(2)}.`,
          }],
        }
      }

      // Fill at historical open price
      const fillPrice = await getHistoricalOpen(sym, state.simDate)
      const qty = dollar_amount / fillPrice

      // Update position (merge with existing)
      if (state.positions[sym]) {
        const existing = state.positions[sym]
        const totalQty = existing.qty + qty
        const newCostBasis = (existing.qty * existing.costBasis + qty * fillPrice) / totalQty
        state.positions[sym] = { qty: totalQty, costBasis: newCostBasis }
      } else {
        state.positions[sym] = { qty, costBasis: fillPrice }
      }

      state.cash -= dollar_amount
      state.orders.push({
        date: state.simDate,
        symbol: sym,
        side: "buy",
        dollarAmount: dollar_amount,
        fillPrice,
        qty,
      })

      writeState(state)

      return {
        content: [{
          type: "text",
          text:
            `✅ [SIMULATED] Buy executed: $${dollar_amount.toFixed(2)} of ${sym}\n` +
            `Fill price: $${fillPrice.toFixed(2)} | Qty: ${qty.toFixed(4)} shares\n` +
            `Remaining cash: $${state.cash.toFixed(2)}\n` +
            `Reason: ${reason}`,
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error executing simulated buy: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  }
)

server.tool(
  "sell_stock",
  "Sell an existing position (fully or partially) by dollar amount (simulated)",
  {
    symbol: z.string().describe("Stock ticker symbol to sell"),
    dollar_amount: z.number().positive().optional().describe("Dollar amount to sell. Omit to sell entire position."),
    reason: z.string().describe("Your reasoning for selling"),
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      const state = readState()
      const sym = symbol.toUpperCase()

      if (!state.positions[sym]) {
        return {
          content: [{
            type: "text",
            text: `Cannot sell ${sym}: no open position in simulation portfolio.`,
          }],
        }
      }

      const position = state.positions[sym]
      const fillPrice = await getHistoricalOpen(sym, state.simDate)
      const currentMarketValue = position.qty * fillPrice

      let qtyToSell: number
      let amountToSell: number

      if (dollar_amount) {
        if (dollar_amount > currentMarketValue) {
          return {
            content: [{
              type: "text",
              text: `Cannot sell $${dollar_amount.toFixed(2)} of ${sym}: current position is only worth $${currentMarketValue.toFixed(2)}. Use a smaller amount or omit dollar_amount for full exit.`,
            }],
          }
        }
        qtyToSell = dollar_amount / fillPrice
        amountToSell = dollar_amount
      } else {
        // Full exit
        qtyToSell = position.qty
        amountToSell = currentMarketValue
      }

      const remainingQty = position.qty - qtyToSell
      if (remainingQty < 0.001) {
        // Full exit
        delete state.positions[sym]
      } else {
        state.positions[sym] = { qty: remainingQty, costBasis: position.costBasis }
      }

      state.cash += amountToSell
      state.orders.push({
        date: state.simDate,
        symbol: sym,
        side: "sell",
        dollarAmount: amountToSell,
        fillPrice,
        qty: qtyToSell,
      })

      writeState(state)

      return {
        content: [{
          type: "text",
          text:
            `✅ [SIMULATED] Sell executed: ${dollar_amount ? `$${amountToSell.toFixed(2)} of` : "full position in"} ${sym}\n` +
            `Fill price: $${fillPrice.toFixed(2)} | Qty sold: ${qtyToSell.toFixed(4)} shares\n` +
            `Cash after: $${state.cash.toFixed(2)}\n` +
            `Reason: ${reason}`,
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error executing simulated sell: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  }
)

server.tool(
  "short_stock",
  "Open a short position — bet that a stock will go DOWN. Use when you have strong conviction a stock or sector will fall (e.g. tariff announcement crushes importers, peace deal crushes defense). Dollar amount is the notional value to short.",
  {
    symbol: z.string().describe("Ticker to short — use inverse ETFs (SH, SDS, SPXS, SQQQ) for broad market shorts, individual stocks for company-specific shorts"),
    dollar_amount: z.number().positive().describe("Notional dollar amount to short"),
    reason: z.string().describe("Why you expect this to fall"),
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      const state = readState()
      const sym = symbol.toUpperCase()

      if (dollar_amount > state.cash) {
        return { content: [{ type: "text", text: `Trade rejected: insufficient cash. Have $${state.cash.toFixed(2)}, tried to short $${dollar_amount.toFixed(2)}.` }] }
      }

      const fillPrice = await getHistoricalOpen(sym, state.simDate)
      const qty = dollar_amount / fillPrice

      // Short positions stored as negative qty
      const existing = state.positions[sym]
      if (existing) {
        const totalQty = existing.qty - qty
        const newCostBasis = (Math.abs(existing.qty) * existing.costBasis + qty * fillPrice) / (Math.abs(existing.qty) + qty)
        state.positions[sym] = { qty: totalQty, costBasis: newCostBasis }
      } else {
        state.positions[sym] = { qty: -qty, costBasis: fillPrice }
      }

      state.cash += dollar_amount  // receive short sale proceeds
      state.orders.push({ date: state.simDate, symbol: sym, side: "sell", dollarAmount: dollar_amount, fillPrice, qty: -qty })
      writeState(state)

      return {
        content: [{ type: "text", text: `✅ [SIMULATED] Short opened: $${dollar_amount.toFixed(2)} of ${sym} @ $${fillPrice.toFixed(2)}\nRemaining cash: $${state.cash.toFixed(2)}\nReason: ${reason}` }],
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error executing simulated short: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.tool(
  "do_nothing",
  "Explicitly decide to make no trades this run. Only call this if you have NOT already called buy_stock or sell_stock — if you already traded, just stop without calling this.",
  {
    reason: z.string().describe("Why you are choosing not to trade"),
  },
  async ({ reason }) => {
    return {
      content: [{
        type: "text",
        text: `✅ [SIMULATED] No trade decision recorded.\nReason: ${reason}`,
      }],
    }
  }
)

server.tool(
  "get_recent_orders",
  "Get the most recent simulated orders to understand recent trading activity",
  {
    limit: z.number().default(5).describe("Number of recent orders to show"),
  },
  async ({ limit }) => {
    try {
      const state = readState()
      const recent = state.orders.slice(-Math.min(limit, state.orders.length)).reverse()

      if (recent.length === 0) {
        return { content: [{ type: "text", text: "[SIMULATION] No orders placed yet in this backtest." }] }
      }

      const lines = recent.map((o) =>
        `${o.date} — ${o.side.toUpperCase()} $${o.dollarAmount.toFixed(2)} of ${o.symbol} @ $${o.fillPrice.toFixed(2)} (${o.qty.toFixed(4)} shares)`
      )

      return {
        content: [{
          type: "text",
          text: `[SIMULATION] Last ${recent.length} orders:\n${lines.join("\n")}`,
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error reading simulated orders: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
