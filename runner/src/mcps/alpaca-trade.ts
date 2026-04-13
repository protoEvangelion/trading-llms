#!/usr/bin/env bun
/**
 * Alpaca Trade MCP Server
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
} from "../alpaca.js"

const server = new McpServer({
  name: "alpaca-trade",
  version: "1.0.0",
})

// bot-runner injects ALPACA_KEY / ALPACA_SECRET / ALPACA_ENDPOINT per-run
const config = getAlpacaConfig("ALPACA_KEY", "ALPACA_SECRET", "ALPACA_ENDPOINT")

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
      // Validate against 20% position limit
      const account = await getAccount(config)
      const portfolioValue = parseFloat(account.portfolio_value)
      const maxAllowed = portfolioValue * 0.20

      if (dollar_amount > maxAllowed) {
        return {
          content: [
            {
              type: "text",
              text: `Trade rejected: $${dollar_amount} exceeds 20% position limit of $${maxAllowed.toFixed(2)} (portfolio: $${portfolioValue.toFixed(2)}). Reduce your order size.`,
            },
          ],
        }
      }

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
  "do_nothing",
  "Explicitly decide to hold current positions and make no trades this run",
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
