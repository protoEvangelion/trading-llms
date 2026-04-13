#!/usr/bin/env bun
/**
 * Truth Social MCP Server
 * Uses Playwright headless Chromium to bypass Cloudflare bot detection
 * and scrape Trump's Truth Social posts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { chromium } from "playwright"

const server = new McpServer({
  name: "truth-social",
  version: "1.0.0",
})

const BASE_URL = "https://truthsocial.com"

// Keep a single browser instance alive for the lifetime of this MCP process
let _browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    })
  }
  return _browser
}

// Cache account ID lookups
const accountIdCache = new Map<string, string>()

async function lookupAccountId(handle: string): Promise<string> {
  if (accountIdCache.has(handle)) return accountIdCache.get(handle)!

  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${BASE_URL}/@${handle}`,
    },
  })

  try {
    const page = await context.newPage()
    // First visit the profile page so Cloudflare issues us a clearance cookie
    await page.goto(`${BASE_URL}/@${handle}`, { waitUntil: "domcontentloaded", timeout: 30_000 })

    // Now hit the API endpoint — Cloudflare cookies are in the context
    const response = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { headers: { Accept: "application/json" } })
      return { status: res.status, body: await res.text() }
    }, `${BASE_URL}/api/v1/accounts/lookup?acct=${handle}`)

    if (response.status !== 200) throw new Error(`Lookup failed: ${response.status} ${response.body.slice(0, 200)}`)
    const data = JSON.parse(response.body) as { id: string; username: string }
    accountIdCache.set(handle, data.id)
    return data.id
  } finally {
    await context.close()
  }
}

interface TruthStatus {
  id: string
  content: string
  created_at: string
  reblogs_count: number
  favourites_count: number
  reblog?: unknown
}

async function fetchPosts(handle: string, lookbackHours: number, maxPosts = 200) {
  const accountId = await lookupAccountId(handle)
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000)

  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${BASE_URL}/@${handle}`,
    },
  })

  try {
    const page = await context.newPage()
    // Prime Cloudflare cookies with a page visit
    await page.goto(`${BASE_URL}/@${handle}`, { waitUntil: "domcontentloaded", timeout: 30_000 })

    const all: TruthStatus[] = []
    let maxId: string | null = null

    while (all.length < maxPosts) {
      const apiUrl = new URL(`${BASE_URL}/api/v1/accounts/${accountId}/statuses`)
      apiUrl.searchParams.set("limit", "40")
      apiUrl.searchParams.set("exclude_replies", "false")
      if (maxId) apiUrl.searchParams.set("max_id", maxId)

      const { status, body } = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { headers: { Accept: "application/json" } })
        return { status: res.status, body: await res.text() }
      }, apiUrl.toString())

      if (status === 429) {
        console.error(`[truth-social] Rate limited on pagination, stopping at ${all.length} posts`)
        break
      }
      if (status !== 200) throw new Error(`Statuses API error: ${status} ${body.slice(0, 200)}`)

      const page_data = JSON.parse(body) as TruthStatus[]
      if (page_data.length === 0) break

      const inWindow = page_data.filter((s) => new Date(s.created_at) >= since)
      all.push(...inWindow)

      const oldest = page_data[page_data.length - 1]
      if (new Date(oldest.created_at) < since) break

      maxId = oldest.id
      // Polite delay between pages
      await Bun.sleep(1500)
    }

    return all.map((s) => ({
      id: s.id,
      content: s.content.replace(/<[^>]+>/g, "").trim(),
      created_at: s.created_at,
      reblogs: s.reblogs_count,
      favourites: s.favourites_count,
      is_retruth: !!s.reblog,
    }))
  } finally {
    await context.close()
  }
}

const DEFAULT_LOOKBACK = parseInt(process.env.TRUTH_SOCIAL_DEFAULT_LOOKBACK ?? "6")
const DEFAULT_MAX_POSTS = parseInt(process.env.TRUTH_SOCIAL_DEFAULT_MAX_POSTS ?? "200")

server.tool(
  "get_truth_social_posts",
  "Fetch recent posts from a Truth Social account. For initialization/research use lookback_hours up to 720 (30 days).",
  {
    handle: z.string().describe("Truth Social handle without @, e.g. realDonaldTrump"),
    lookback_hours: z
      .number()
      .default(DEFAULT_LOOKBACK)
      .describe("How many hours back to fetch posts. Use 720 for a full 30-day lookback."),
    max_posts: z
      .number()
      .default(DEFAULT_MAX_POSTS)
      .describe("Max posts to return. Increase for long lookbacks."),
  },
  async ({ handle, lookback_hours, max_posts }) => {
    try {
      const posts = await fetchPosts(handle, lookback_hours, max_posts)

      if (posts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No posts found from @${handle} in the last ${lookback_hours} hours.`,
            },
          ],
        }
      }

      // Group by day for long lookbacks to keep context manageable
      const isLongLookback = lookback_hours > 48
      let formatted: string

      if (isLongLookback) {
        const byDay = new Map<string, typeof posts>()
        for (const p of posts) {
          const day = p.created_at.slice(0, 10)
          if (!byDay.has(day)) byDay.set(day, [])
          byDay.get(day)!.push(p)
        }

        const days = [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a))
        formatted = days
          .map(([day, dayPosts]) => {
            const postLines = dayPosts
              .map(
                (p) =>
                  `  • ${p.is_retruth ? "[RT] " : ""}${p.content.slice(0, 300)}${p.content.length > 300 ? "…" : ""}`
              )
              .join("\n")
            return `=== ${day} (${dayPosts.length} posts) ===\n${postLines}`
          })
          .join("\n\n")
      } else {
        formatted = posts
          .map(
            (p) =>
              `[${p.created_at}] ${p.is_retruth ? "(Re-Truth) " : ""}${p.content}\n` +
              `  ↩️ ${p.reblogs} re-truths | ❤️ ${p.favourites} likes`
          )
          .join("\n\n")
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${posts.length} posts from @${handle} over the last ${lookback_hours} hours:\n\n${formatted}`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching Truth Social posts: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)

// Clean up browser on exit
process.on("exit", () => { _browser?.close() })
process.on("SIGINT", () => { _browser?.close(); process.exit(0) })
process.on("SIGTERM", () => { _browser?.close(); process.exit(0) })
