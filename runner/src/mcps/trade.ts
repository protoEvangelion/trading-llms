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

const server = new McpServer({
  name: "trade",
  version: "1.0.0",
})

// bot-runner injects ALPACA_KEY / ALPACA_SECRET / ALPACA_ENDPOINT per-run
const config = getAlpacaConfig("ALPACA_KEY", "ALPACA_SECRET", "ALPACA_ENDPOINT")

server.tool(
  "get_market_snapshot",
  "Get SPY (S&P 500) recent performance to gauge overall market regime. Call this first, before any buy/sell decision.",
  {},
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

      const [d0, d1, ...rest] = bars // d0 = most recent, d1 = day before
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

server.tool(
  "get_portfolio",
  "Get current portfolio summary including cash, equity, buying power, and all open positions",
  {},
  async () => {
    try {
      const [account, positions] = await Promise.all([
        getAccount(config),
        getPositions(config),
      ])

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
      return {
        content: [
          { type: "text", text: `Error fetching portfolio: ${err instanceof Error ? err.message : String(err)}` },
        ],
      }
    }
  }
)

server.tool(
  "buy_stock",
  "Buy a stock or ETF using a dollar amount. Use this when you have a strong conviction signal.",
  {
    symbol: z.string().describe("Stock ticker symbol e.g. AAPL, SPY, DJT"),
    dollar_amount: z
      .number()
      .positive()
      .describe("Dollar amount to invest — not number of shares"),
    reason: z
      .string()
      .describe("Your reasoning for this trade — required, be specific about which signal drove it"),
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      const order = await submitOrder(config, {
        symbol: symbol.toUpperCase(),
        notional: dollar_amount,
        side: "buy",
      })

      return {
        content: [
          {
            type: "text",
            text: `✅ Buy order submitted: $${dollar_amount} of ${symbol.toUpperCase()}\nReason: ${reason}\nOrder: ${JSON.stringify(order, null, 2)}`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Error placing buy order: ${err instanceof Error ? err.message : String(err)}` },
        ],
      }
    }
  }
)

server.tool(
  "sell_stock",
  "Sell an existing position (fully or partially) by dollar amount",
  {
    symbol: z.string().describe("Stock ticker symbol to sell"),
    dollar_amount: z
      .number()
      .positive()
      .optional()
      .describe("Dollar amount to sell. Omit to sell entire position."),
    reason: z.string().describe("Your reasoning for selling"),
  },
  async ({ symbol, dollar_amount, reason }) => {
    try {
      let order: unknown

      if (dollar_amount) {
        order = await submitOrder(config, {
          symbol: symbol.toUpperCase(),
          notional: dollar_amount,
          side: "sell",
        })
      } else {
        order = await closePosition(config, symbol.toUpperCase())
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Sell order submitted: ${dollar_amount ? `$${dollar_amount} of` : "full position in"} ${symbol.toUpperCase()}\nReason: ${reason}\nOrder: ${JSON.stringify(order, null, 2)}`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Error placing sell order: ${err instanceof Error ? err.message : String(err)}` },
        ],
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
      const order = await submitOrder(config, {
        symbol: symbol.toUpperCase(),
        notional: dollar_amount,
        side: "sell",
      })
      return {
        content: [{ type: "text", text: `✅ Short order submitted: $${dollar_amount} of ${symbol.toUpperCase()}\nReason: ${reason}\nOrder: ${JSON.stringify(order, null, 2)}` }],
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error placing short order: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.tool(
  "do_nothing",
  "Explicitly decide to make no trades this run. Only call this if you have NOT already called buy_stock or sell_stock — if you already traded, just stop without calling this.",
  {
    reason: z
      .string()
      .describe("Why you are choosing not to trade — be specific about what signals you saw and why they don't warrant action"),
  },
  async ({ reason }) => {
    return {
      content: [
        {
          type: "text",
          text: `✅ No trade decision recorded.\nReason: ${reason}`,
        },
      ],
    }
  }
)

server.tool(
  "get_recent_orders",
  "Get the most recent orders to understand recent trading activity",
  {
    limit: z.number().default(5).describe("Number of recent orders to fetch"),
  },
  async ({ limit }) => {
    try {
      const orders = await getOrders(config, "all", limit)
      return {
        content: [
          {
            type: "text",
            text: `Recent orders:\n${JSON.stringify(orders, null, 2)}`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Error fetching orders: ${err instanceof Error ? err.message : String(err)}` },
        ],
      }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
