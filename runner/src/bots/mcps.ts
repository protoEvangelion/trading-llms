/**
 * Shared MCP tool configurations reused across bot definitions.
 */
import type { McpConfig } from "../mcp-client.js"

/** Reads Trump's Truth Social posts from the local trump_posts SQLite table. */
export const trumpPostsMcp: McpConfig = {
  name: "trump-posts",
  command: "bun",
  args: ["run", "runner/src/mcps/trump-posts.ts"],
}

/** Financial news via Alpaca News API + DuckDuckGo fallback */
export const webSearchMcp: McpConfig = {
  name: "web-search",
  command: "bun",
  args: ["run", "runner/src/mcps/web-search.ts"],
}

/** Portfolio management + order execution via Alpaca paper trading */
export const alpacaTradeMcp: McpConfig = {
  name: "trade",
  command: "bun",
  args: ["run", "runner/src/mcps/trade.ts"],
}
