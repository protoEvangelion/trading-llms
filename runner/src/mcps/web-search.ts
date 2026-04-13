#!/usr/bin/env bun
/**
 * Web Search MCP Server
 * - financial_news: Alpaca News API (real timestamped headlines, requires Alpaca credentials)
 * - general: DuckDuckGo Instant Answer API (no key needed, good for encyclopedic lookups)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({
  name: "web-search",
  version: "1.0.0",
})

// ─── Alpaca News API ─────────────────────────────────────────────────────────

const ALPACA_DATA_BASE = "https://data.alpaca.markets"

interface AlpacaNewsItem {
  id: number
  headline: string
  summary: string
  author: string
  created_at: string
  updated_at: string
  url: string
  symbols: string[]
  source: string
}

interface AlpacaNewsResponse {
  news: AlpacaNewsItem[]
  next_page_token: string | null
}

/**
 * Rough keyword → ticker mapping so the LLM can search "Iran oil tensions"
 * and we still fetch relevant Alpaca news.
 */
const KEYWORD_TICKER_MAP: Record<string, string[]> = {
  iran: ["USO", "XLE", "XOM", "CVX", "LMT", "RTX", "NOC"],
  oil: ["USO", "XLE", "XOM", "CVX", "HAL", "OXY"],
  energy: ["XLE", "XOM", "CVX", "HAL", "OXY", "USO"],
  opec: ["USO", "XLE", "XOM", "CVX"],
  "middle east": ["USO", "XLE", "LMT", "RTX", "NOC"],
  defense: ["LMT", "RTX", "NOC", "GD", "BA"],
  military: ["LMT", "RTX", "NOC", "GD"],
  tariff: ["SPY", "AAPL", "NIKE", "NKE", "XLI", "DXJ"],
  china: ["SPY", "AAPL", "BABA", "FXI", "KWEB"],
  trade: ["SPY", "XLI", "AAPL", "NKE"],
  crypto: ["MSTR", "COIN", "IBIT", "BITO", "GBTC"],
  bitcoin: ["MSTR", "COIN", "IBIT", "BITO"],
  fed: ["GLD", "TLT", "SPY", "IYR"],
  "interest rate": ["GLD", "TLT", "SPY", "IYR"],
  gold: ["GLD", "GDX", "IAU"],
  dollar: ["GLD", "UUP", "FXE"],
  pharma: ["XPH", "IBB", "PFE", "MRNA", "JNJ"],
  healthcare: ["XLV", "IBB", "UNH", "CVS"],
  immigration: ["GEO", "CXW"],
  prison: ["GEO", "CXW"],
  steel: ["X", "NUE", "STLD", "CLF"],
  infrastructure: ["XLI", "CAT", "DE", "X", "NUE"],
}

function extractTickers(query: string): string[] {
  const upper = query.toUpperCase()
  const lower = query.toLowerCase()
  const tickers = new Set<string>()

  // Match explicit ticker-like tokens: 1-5 uppercase letters possibly with numbers
  for (const match of upper.matchAll(/\b([A-Z]{1,5})\b/g)) {
    const t = match[1]
    // Filter out common English words that happen to be all-caps
    if (!["A", "I", "IN", "OR", "AND", "THE", "FOR", "TO", "OF", "AT", "BY",
          "UP", "IF", "IT", "ON", "IS", "AS", "US", "AN", "BE", "DO", "GO",
          "NO", "SO", "WE", "MY", "HE", "ME", "HI", "OK", "TS"].includes(t)) {
      tickers.add(t)
    }
  }

  // Map keywords to known tickers
  for (const [keyword, mapped] of Object.entries(KEYWORD_TICKER_MAP)) {
    if (lower.includes(keyword)) {
      for (const t of mapped) tickers.add(t)
    }
  }

  // Default to broad market if nothing found
  if (tickers.size === 0) {
    return ["SPY", "QQQ", "DIA"]
  }

  return [...tickers].slice(0, 10)
}

async function fetchAlpacaNews(query: string, limit = 20, lookbackDays = 7): Promise<string> {
  const key = process.env.ALPACA_TRUMP_BOT_KEY
  const secret = process.env.ALPACA_TRUMP_BOT_SECRET
  if (!key || !secret) throw new Error("Missing Alpaca credentials (ALPACA_TRUMP_BOT_KEY / ALPACA_TRUMP_BOT_SECRET)")

  const tickers = extractTickers(query)
  const start = new Date(Date.now() - lookbackDays * 86400 * 1000).toISOString()

  const url = new URL(`${ALPACA_DATA_BASE}/v1beta1/news`)
  url.searchParams.set("symbols", tickers.join(","))
  url.searchParams.set("start", start)
  url.searchParams.set("limit", String(Math.min(limit, 50)))
  url.searchParams.set("sort", "desc")
  url.searchParams.set("include_content", "false")

  const res = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Alpaca News API error ${res.status}: ${text}`)
  }

  const data = await res.json() as AlpacaNewsResponse
  const items = data.news ?? []

  if (items.length === 0) {
    return `No news found for tickers [${tickers.join(", ")}] in the last ${lookbackDays} days.`
  }

  const lines = items.map((n) => {
    const date = n.created_at.slice(0, 10)
    const syms = n.symbols.length > 0 ? ` [${n.symbols.join(", ")}]` : ""
    const summary = n.summary ? `\n  ${n.summary.slice(0, 200)}` : ""
    return `${date}${syms} — ${n.headline}${summary}\n  Source: ${n.source} | ${n.url}`
  })

  return `Found ${items.length} news articles for [${tickers.join(", ")}]:\n\n` + lines.join("\n\n")
}

// ─── DuckDuckGo fallback for non-financial general queries ────────────────────

const DDG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
}

interface DdgResult {
  AbstractText: string
  AbstractURL: string
  RelatedTopics: Array<{
    Text?: string
    FirstURL?: string
    Topics?: Array<{ Text: string; FirstURL: string }>
  }>
}

async function searchDuckDuckGo(query: string, maxResults = 8): Promise<string> {
  const url = new URL("https://api.duckduckgo.com/")
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  url.searchParams.set("no_html", "1")
  url.searchParams.set("skip_disambig", "1")

  const res = await fetch(url.toString(), { headers: DDG_HEADERS })
  if (!res.ok) throw new Error(`DDG API error: ${res.status}`)

  const data = await res.json() as DdgResult
  const results: string[] = []

  if (data.AbstractText) {
    results.push(`Summary: ${data.AbstractText}\nSource: ${data.AbstractURL}`)
  }

  for (const topic of data.RelatedTopics ?? []) {
    if (results.length >= maxResults) break
    if (topic.Text && topic.FirstURL) results.push(`${topic.Text}\n${topic.FirstURL}`)
    for (const sub of topic.Topics ?? []) {
      if (results.length >= maxResults) break
      results.push(`${sub.Text}\n${sub.FirstURL}`)
    }
  }

  return results.length > 0
    ? results.join("\n\n---\n\n")
    : `No results found for: "${query}"`
}

// ─── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  "web_search",
  "Search for current news and information. Use financial_news for market/ticker/policy news (powered by Alpaca News API). Use general for encyclopedic lookups.",
  {
    query: z
      .string()
      .describe(
        "Search query. For financial_news, include ticker symbols or keywords like 'Iran oil', 'China tariffs', 'bitcoin'. The tool will map them to relevant tickers automatically."
      ),
    type: z
      .enum(["general", "financial_news"])
      .default("financial_news")
      .describe("financial_news uses Alpaca News API (real headlines). general uses DuckDuckGo."),
    lookback_days: z
      .number()
      .default(7)
      .describe("How many days back to search news (financial_news only). Default 7."),
  },
  async ({ query, type, lookback_days }) => {
    try {
      const results =
        type === "financial_news"
          ? await fetchAlpacaNews(query, 20, lookback_days)
          : await searchDuckDuckGo(query)

      return {
        content: [{ type: "text", text: `Search results for "${query}":\n\n${results}` }],
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
