#!/usr/bin/env bun
/**
 * Trump Posts MCP Server
 *
 * Queries the trump_posts SQLite table (populated by scripts/scrape-trump-posts.ts).
 * In backtest mode, set the SIM_DATE env var to cap results to that date.
 *
 * Tool: get_trump_posts(lookback_days: 1–30)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { Database } from "bun:sqlite"
import { join } from "path"
import { mkdirSync } from "fs"
import { readSimDate } from "../harness-mode/mcps/sim-clock.js"
import { getMarketOpenUtc } from "../simulation.js"

const server = new McpServer({
  name: "trump-posts",
  version: "1.0.0",
})

// Scraped source data lives in a single shared DB regardless of trading env
const dataDir = process.env.TRADING_BOTS_DATA_DIR ?? join(import.meta.dir, "../../../../data")
mkdirSync(dataDir, { recursive: true })
const DB_PATH = join(dataDir, "sources.db")

// Agent-mode: SIM_DATETIME_UTC / SIM_DATE set at boot per tick (static)
// Harness-mode: SIM_CLOCK_STATE_FILE set at boot; date read dynamically each call
const SIM_DATETIME_UTC_ENV = process.env.SIM_DATETIME_UTC ?? null
const SIM_DATE_ENV = process.env.SIM_DATE ?? null
const SIM_CLOCK_STATE_FILE = process.env.SIM_CLOCK_STATE_FILE ?? null

function getSimDate(): { date: string | null; datetime: string | null } {
  const date = readSimDate(SIM_CLOCK_STATE_FILE) ?? SIM_DATE_ENV
  const datetime = SIM_DATETIME_UTC_ENV ?? (date ? getMarketOpenUtc(date) : null)
  return { date, datetime }
}

const RESPONSE_TOKEN_LIMIT = 4000

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

interface TrumpPostRow {
  post_id: string
  content: string
  posted_at: string
  is_retruth: number
}

server.tool(
  "get_trump_posts",
  "Fetch Trump's Truth Social posts from the local database. Posts are pre-scraped. Choose lookback_days based on how much context you need — shorter is faster and cheaper. Max 30 days.",
  {
    lookback_days: z
      .number()
      .min(1)
      .max(30)
      .default(7)
      .describe("How many days back to fetch posts (1–30). Start with 3–7 days; only go to 30 for initialization runs."),
  },
  async ({ lookback_days }) => {
    const clampedDays = Math.min(30, Math.max(1, Math.floor(lookback_days)))

    let db: Database | null = null
    try {
      db = new Database(DB_PATH, { readonly: true })

      const { date: simDate, datetime: simDatetimeUtc } = getSimDate()

      // Anchor: precise UTC sim time > date-only fallback > now (live)
      const anchorDate = simDatetimeUtc
        ? new Date(simDatetimeUtc)
        : simDate
          ? new Date(simDate)
          : new Date()
      const fromDate = new Date(anchorDate)
      fromDate.setDate(fromDate.getDate() - clampedDays)

      const posts = db.query<TrumpPostRow, [string, string]>(
        `SELECT post_id, content, posted_at, is_retruth
         FROM trump_posts
         WHERE posted_at >= ? AND posted_at <= ?
         ORDER BY posted_at DESC`
      ).all(fromDate.toISOString(), anchorDate.toISOString())

      if (posts.length === 0) {
        const modeNote = simDate ? ` (simulation date: ${simDate})` : ""
        return {
          content: [
            {
              type: "text",
              text:
                `No Trump posts found for the last ${clampedDays} days${modeNote}. ` +
                `The database may not have posts for this period. ` +
                `If running a backtest, ensure scripts/scrape-trump-posts.ts --init has been run.`,
            },
          ],
        }
      }

      // Format posts, truncating from oldest → newest until we fit within token budget
      const modeNote = simDatetimeUtc
        ? ` (as of ${simDatetimeUtc.slice(0, 16)} UTC)`
        : simDate
          ? ` (as of ${simDate})`
          : ""
      const header = `Found ${posts.length} Trump post${posts.length === 1 ? "" : "s"} from the last ${clampedDays} day${clampedDays === 1 ? "" : "s"}${modeNote}:\n\n`
      const headerTokens = roughTokenCount(header)

      const lines: string[] = []
      let usedTokens = headerTokens
      let truncated = 0

      for (const p of posts) {
        const prefix = p.is_retruth ? "[Re-Truth] " : ""
        const content = p.content.length > 500 ? p.content.slice(0, 500) + "…" : p.content
        const line = `[${p.posted_at.slice(0, 16)} ET] ${prefix}${content}`
        const lineTokens = roughTokenCount(line) + 3 // +3 for "\n\n" separator
        if (usedTokens + lineTokens > RESPONSE_TOKEN_LIMIT) {
          truncated = posts.length - lines.length
          break
        }
        lines.push(line)
        usedTokens += lineTokens
      }

      const truncatedNote = truncated > 0 ? `\n\n[${truncated} older post${truncated === 1 ? "" : "s"} omitted to stay within context limit]` : ""
      const responseText = header + lines.join("\n\n") + truncatedNote

      return { content: [{ type: "text", text: responseText }] }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading trump_posts: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
    } finally {
      db?.close()
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
