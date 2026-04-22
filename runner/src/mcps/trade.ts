#!/usr/bin/env bun
/**
 * Trade MCP Server
 * Exposes portfolio management and trading tools to the LLM
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  getAlpacaConfig,
  getAccount,
  getPositions,
  submitOrder,
  closePosition,
  getOrders,
  getRecentBars,
} from "../alpaca.js"
import { getDb, logPnlSnapshot } from "../db.js"

const server = new McpServer({
  name: "trade",
  version: "1.0.0",
})

// bot-runner injects ALPACA_KEY / ALPACA_SECRET / ALPACA_ENDPOINT per-run
const config = getAlpacaConfig("ALPACA_KEY", "ALPACA_SECRET", "ALPACA_ENDPOINT")

const HARNESS_BOT_ID = process.env.HARNESS_BOT_ID ?? null
const HARNESS_RUN_ID = process.env.HARNESS_RUN_ID ? parseInt(process.env.HARNESS_RUN_ID, 10) : null
const HARNESS_MODE = process.env.HARNESS_MODE ?? null

async function snapshotPortfolio(): Promise<void> {
  if (!HARNESS_BOT_ID || HARNESS_RUN_ID == null || !HARNESS_MODE) return
  try {
    const [account, positions] = await Promise.all([getAccount(config), getPositions(config)])
    const posMap: Record<string, { qty: number; costBasis: number }> = {}
    for (const p of positions) {
      posMap[p.symbol] = {
        qty: parseFloat(p.qty),
        costBasis: parseFloat(p.avg_entry_price) * parseFloat(p.qty),
      }
    }

    // Compute normalized spy_value: (today_spy / baseline_spy) * 100_000
    // Baseline = earliest pnl_snapshot date for this bot that has spy_value set.
    // If none exists yet, this is the first snapshot — use 100_000 as the baseline.
    let spyValue: number | undefined
    try {
      const db = getDb()
      const firstSnap = db.query<{ timestamp: string }, [string]>(
        "SELECT timestamp FROM pnl_snapshots WHERE bot_id = ? AND spy_value IS NOT NULL ORDER BY timestamp ASC LIMIT 1"
      ).get(HARNESS_BOT_ID)

      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const todayStr = yesterday.toISOString().slice(0, 10)

      if (!firstSnap) {
        spyValue = 100_000
      } else {
        const baselineDate = firstSnap.timestamp.slice(0, 10)
        const lookbackStart = new Date(yesterday)
        lookbackStart.setDate(lookbackStart.getDate() - 3)
        const bars = await getRecentBars(config, ["SPY"], {
          start: lookbackStart.toISOString().slice(0, 10),
          end: todayStr,
          limit: 10,
          sort: "asc",
        })
        const spyBars = bars["SPY"] ?? []
        const baseSpy = spyBars.find((b) => b.t.startsWith(baselineDate))?.c ?? spyBars[0]?.c
        const todaySpy = spyBars[spyBars.length - 1]?.c
        if (baseSpy && todaySpy) spyValue = (todaySpy / baseSpy) * 100_000
      }
    } catch {
      // SPY fetch is best-effort — don't fail the snapshot
    }

    logPnlSnapshot({
      botId: HARNESS_BOT_ID,
      mode: HARNESS_MODE,
      runId: HARNESS_RUN_ID,
      portfolioValue: parseFloat(account.portfolio_value),
      cash: parseFloat(account.cash),
      positions: posMap,
      spyValue,
    })
  } catch (err) {
    console.error("[trade-mcp] PnL snapshot failed:", err)
  }
}

server.registerTool(
  "get_market_snapshot",
  {
    description: "Get SPY (S&P 500) recent performance to gauge overall market regime. Call this first, before any buy/sell decision.",
  },
  async () => {
    try {
      const end = new Date()
      end.setDate(end.getDate() - 1)
      const start = new Date(end)
      start.setDate(start.getDate() - 12)
      const allBars = await getRecentBars(config, ["SPY"], {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
        limit: 6,
        sort: "desc",
      })
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
        `SPY: $${d0.close.toFixed(2)} (${d0.date})`,
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

server.registerTool(
  "get_portfolio",
  {
    description: "Get current portfolio summary including cash, equity, buying power, and all open positions",
  },
  async () => {
    try {
      const [account, positions] = await Promise.all([getAccount(config), getPositions(config)])

      const positionSummary = positions.length === 0
        ? "No open positions."
        : positions
            .map(
              (p) =>
                `${p.symbol}: ${p.qty} shares @ avg $${p.avg_entry_price} | ` +
                `current $${p.current_price} | ` +
                `P&L: $${p.unrealized_pl} (${(parseFloat(p.unrealized_plpc) * 100).toFixed(2)}%) | ` +
                `market value: $${p.market_value}`
            )
            .join("\n")

      const text =
        `Portfolio Value: $${parseFloat(account.portfolio_value).toLocaleString()}\n` +
        `Cash: $${parseFloat(account.cash).toLocaleString()}\n` +
        `Buying Power: $${parseFloat(account.buying_power).toLocaleString()}\n` +
        `\nOpen Positions (${positions.length}):\n${positionSummary}`

      return { content: [{ type: "text", text }] }
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching portfolio: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.registerTool(
  "buy_stock",
  {
    description: "Buy a stock or ETF using a dollar amount. Use this when you have a strong conviction signal.",
    inputSchema: {
      symbol: z.string().describe("Stock ticker symbol e.g. AAPL, SPY, DJT"),
      dollar_amount: z.number().positive().describe("Dollar amount to invest — not number of shares"),
      reason: z.string().describe("Your reasoning for this trade — required, be specific about which signal drove it"),
    },
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      const order = await submitOrder(config, {
        symbol: symbol.toUpperCase(),
        notional: dollar_amount,
        side: "buy",
      })
      await snapshotPortfolio()
      return {
        content: [{
          type: "text",
          text: `✅ Buy order submitted: $${dollar_amount} of ${symbol.toUpperCase()}\nReason: ${reason}\nOrder: ${JSON.stringify(order, null, 2)}`,
        }],
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error placing buy order: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.registerTool(
  "sell_stock",
  {
    description: "Sell an existing position (fully or partially) by dollar amount",
    inputSchema: {
      symbol: z.string().describe("Stock ticker symbol to sell"),
      dollar_amount: z.number().positive().optional().describe("Dollar amount to sell. Omit to sell entire position."),
      reason: z.string().describe("Your reasoning for selling"),
    },
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      const order = dollar_amount
        ? await submitOrder(config, { symbol: symbol.toUpperCase(), notional: dollar_amount, side: "sell" })
        : await closePosition(config, symbol.toUpperCase())
      await snapshotPortfolio()
      return {
        content: [{
          type: "text",
          text: `✅ Sell order submitted: ${dollar_amount ? `$${dollar_amount} of` : "full position in"} ${symbol.toUpperCase()}\nReason: ${reason}\nOrder: ${JSON.stringify(order, null, 2)}`,
        }],
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error placing sell order: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.registerTool(
  "short_stock",
  {
    description: "Open a short position — bet that a stock will go DOWN. Use when you have strong conviction a stock or sector will fall (e.g. tariff announcement crushes importers, peace deal crushes defense). Dollar amount is the notional value to short.",
    inputSchema: {
      symbol: z.string().describe("Ticker to short — use inverse ETFs (SH, SDS, SPXS, SQQQ) for broad market shorts, individual stocks for company-specific shorts"),
      dollar_amount: z.number().positive().describe("Notional dollar amount to short"),
      reason: z.string().describe("Why you expect this to fall"),
    },
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      const order = await submitOrder(config, { symbol: symbol.toUpperCase(), notional: dollar_amount, side: "sell" })
      await snapshotPortfolio()
      return {
        content: [{ type: "text", text: `✅ Short order submitted: $${dollar_amount} of ${symbol.toUpperCase()}\nReason: ${reason}\nOrder: ${JSON.stringify(order, null, 2)}` }],
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error placing short order: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.registerTool(
  "do_nothing",
  {
    description: "Explicitly decide to make no trades this run. Only call this if you have NOT already called buy_stock or sell_stock — if you already traded, just stop without calling this.",
    inputSchema: {
      reason: z.string().describe("Why you are choosing not to trade — be specific about what signals you saw and why they don't warrant action"),
    },
  },
  async ({ reason }) => {
    await snapshotPortfolio()
    return {
      content: [{ type: "text", text: `✅ No trade decision recorded.\nReason: ${reason}` }],
    }
  }
)

server.registerTool(
  "get_recent_orders",
  {
    description: "Get the most recent orders to understand recent trading activity",
    inputSchema: {
      limit: z.number().default(5).describe("Number of recent orders to fetch"),
    },
  },
  async ({ limit }) => {
    try {
      const orders = await getOrders(config, "all", limit)
      return { content: [{ type: "text", text: `Recent orders:\n${JSON.stringify(orders, null, 2)}` }] }
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching orders: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
