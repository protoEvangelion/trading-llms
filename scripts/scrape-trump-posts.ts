#!/usr/bin/env bun
/**
 * Trump posts scraper + signal filter
 *
 * Scrapes Trump's Truth Social posts via Playwright (Cloudflare bypass),
 * stores them in trump_posts, then runs an LLM filter pass on new posts:
 *   - Deletes posts with no trading relevance (book plugs, sports, pure slogans)
 *   - Condenses relevant posts to a tight 1-2 sentence signal summary
 *
 * Usage:
 *   bun run scripts/scrape-trump-posts.ts --init     # last 365 days
 *   bun run scripts/scrape-trump-posts.ts --update   # from MAX(posted_at) to now
 */

import { chromium } from "playwright"
import { join } from "path"
import { mkdirSync } from "fs"
import { Database } from "bun:sqlite"

// ─── DB setup ─────────────────────────────────────────────────────────────────

// Scraped source data lives in a single shared DB regardless of trading env
const dataDir = process.env.TRADING_BOTS_DATA_DIR ?? join(import.meta.dir, "../data")
mkdirSync(dataDir, { recursive: true })
const DB_PATH = join(dataDir, "sources.db")

const db = new Database(DB_PATH)
db.run("PRAGMA journal_mode=WAL")

db.run(`
  CREATE TABLE IF NOT EXISTS trump_posts (
    post_id     TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    posted_at   TEXT NOT NULL,
    is_retruth  INTEGER NOT NULL DEFAULT 0,
    scraped_at  TEXT NOT NULL,
    filtered_at TEXT
  )
`)
db.run(`CREATE INDEX IF NOT EXISTS idx_trump_posts_posted_at ON trump_posts(posted_at DESC)`)
// Migration: add filtered_at to existing DBs that don't have it yet
try { db.run("ALTER TABLE trump_posts ADD COLUMN filtered_at TEXT") } catch {}

// ─── Playwright helpers ───────────────────────────────────────────────────────

const BASE_URL = "https://truthsocial.com"
const HANDLE = "realDonaldTrump"

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

interface TruthStatus {
  id: string
  content: string
  created_at: string
  reblogs_count: number
  favourites_count: number
  reblog?: unknown
}

async function lookupAccountId(
  browser: Awaited<ReturnType<typeof chromium.launch>>
): Promise<string> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    extraHTTPHeaders: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${BASE_URL}/@${HANDLE}`,
    },
  })
  try {
    const page = await context.newPage()
    await page.goto(`${BASE_URL}/@${HANDLE}`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    const response = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { headers: { Accept: "application/json" } })
      return { status: res.status, body: await res.text() }
    }, `${BASE_URL}/api/v1/accounts/lookup?acct=${HANDLE}`)
    if (response.status !== 200) throw new Error(`Account lookup failed: ${response.status}`)
    const data = JSON.parse(response.body) as { id: string }
    console.log(`[scraper] Account ID for @${HANDLE}: ${data.id}`)
    return data.id
  } finally {
    await context.close()
  }
}

async function fetchPostsSince(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  accountId: string,
  since: Date,
  maxPosts = 2000,
): Promise<TruthStatus[]> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    extraHTTPHeaders: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${BASE_URL}/@${HANDLE}`,
    },
  })

  try {
    const page = await context.newPage()
    await page.goto(`${BASE_URL}/@${HANDLE}`, { waitUntil: "domcontentloaded", timeout: 30_000 })

    const all: TruthStatus[] = []
    let maxId: string | null = null
    let page_num = 0

    while (all.length < maxPosts) {
      page_num++
      const apiUrl = new URL(`${BASE_URL}/api/v1/accounts/${accountId}/statuses`)
      apiUrl.searchParams.set("limit", "40")
      apiUrl.searchParams.set("exclude_replies", "false")
      if (maxId) apiUrl.searchParams.set("max_id", maxId)

      const { status, body } = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { headers: { Accept: "application/json" } })
        return { status: res.status, body: await res.text() }
      }, apiUrl.toString())

      if (status === 429) {
        console.warn(`[scraper] Rate limited at page ${page_num} — waiting 60s before retry...`)
        await Bun.sleep(60_000)
        continue
      }
      if (status !== 200) throw new Error(`API error ${status}: ${body.slice(0, 200)}`)

      const posts = JSON.parse(body) as TruthStatus[]
      if (posts.length === 0) {
        console.log(`[scraper] Empty page at page ${page_num} — reached end of timeline`)
        break
      }

      const inWindow = posts.filter((s) => new Date(s.created_at) >= since)
      all.push(...inWindow)

      const oldest = posts[posts.length - 1]
      const oldestDate = new Date(oldest.created_at)
      console.log(`[scraper] Page ${page_num}: ${posts.length} posts, oldest: ${oldest.created_at}, in-window: ${inWindow.length}`)

      if (oldestDate < since) {
        console.log(`[scraper] Reached lookback boundary — stopping`)
        break
      }

      maxId = oldest.id
      await Bun.sleep(3000)
    }

    return all
  } finally {
    await context.close()
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim()
}

function savePosts(posts: TruthStatus[]): string[] {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO trump_posts (post_id, content, posted_at, is_retruth, scraped_at)
     VALUES (?, ?, ?, ?, ?)`
  )

  const savedIds: string[] = []
  const now = new Date().toISOString()

  for (const post of posts) {
    const content = stripHtml(post.content)
    if (!content) continue
    const result = insert.run(post.id, content, post.created_at, post.reblog ? 1 : 0, now)
    if (result.changes > 0) savedIds.push(post.id)
  }

  return savedIds
}

// ─── LLM signal filter ────────────────────────────────────────────────────────

// Free models ranked by capability — fallback down the list on timeout or model error
const FREE_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",  // 120B — most capable
  "google/gemma-4-31b-it:free",              // Gemma 4 31B
  "minimax/minimax-m2.5:free",               // MiniMax M2.5
  "google/gemma-4-26b-a4b-it:free",          // Gemma 4 26B MoE
  "arcee-ai/trinity-large-preview:free",     // last resort
]

const FILTER_TIMEOUT_MS = 120_000 // 2 min — free 120B models can be slow
const FILTER_BATCH_SIZE = 10       // smaller batches = fewer tokens = more reliable

const FILTER_SYSTEM_PROMPT = `You are a trading signal filter for Trump's Truth Social posts.

For each post, decide:
1. RELEVANT? A post is relevant if it contains anything that could move financial markets:
   trade policy, tariffs, sanctions, specific companies or sectors praised/attacked,
   energy policy (drill/oil/gas/solar), defense/military actions or threats,
   crypto/Bitcoin, Fed/interest rates, immigration (private prison stocks),
   infrastructure/made-in-America, regulatory announcements, or major personnel
   decisions (Fed chair, agency heads).

2. If RELEVANT, write a CONCISE SUMMARY (1 sentence max) — strip the rhetoric, keep
   only the market-relevant substance. No filler. Example:
   "Trump doubles steel/aluminum tariffs to 50%, effective June 4."

NOT relevant (delete these): book plugs, sports commentary, personal grievances,
generic MAGA slogans, rally/event announcements, retweets of random supporters
with no policy content, celebrity praise with no policy angle, random URLs.

Be aggressive about filtering — if there's no clear market angle, mark relevant: false.

Return ONLY valid JSON, no markdown:
{"results": [{"post_id": "...", "relevant": true, "summary": "..."}, {"post_id": "...", "relevant": false, "summary": null}]}`

interface FilterResult {
  post_id: string
  relevant: boolean
  summary: string | null
}

// Errors that warrant trying the next model (not just retrying the same one)
function isFallbackError(status: number): boolean {
  return status === 408 || status === 503 || status === 429 || status >= 500
}

async function callFilterLLM(posts: Array<{ post_id: string; content: string }>): Promise<FilterResult[]> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set")

  const userContent = JSON.stringify(posts.map((p) => ({ post_id: p.post_id, content: p.content })))

  for (let i = 0; i < FREE_MODELS.length; i++) {
    const model = FREE_MODELS[i]
    const isLast = i === FREE_MODELS.length - 1

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FILTER_TIMEOUT_MS)

    try {
      console.log(`[filter] Trying model: ${model}`)
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/trading-bots",
          "X-Title": "Trading Bots",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: FILTER_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          temperature: 0.1,
          max_tokens: 2048,
          response_format: { type: "json_object" },
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        if (!isLast && isFallbackError(res.status)) {
          if (res.status === 429) {
            console.warn(`[filter] ${model} rate limited — waiting 60s before next model`)
            await Bun.sleep(60_000)
          } else {
            console.warn(`[filter] ${model} returned ${res.status} — trying next model`)
          }
          continue
        }
        throw new Error(`OpenRouter filter API error ${res.status}: ${body.slice(0, 300)}`)
      }

      const data = await res.json() as { choices: Array<{ message: { content: string } }> }
      let raw = data.choices[0].message.content.trim()
      // Strip markdown fences if the model wrapped the JSON
      raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
      const parsed = JSON.parse(raw) as { results: FilterResult[] }
      if (!Array.isArray(parsed.results)) throw new TypeError("results not an array")
      console.log(`[filter] ✓ ${model}`)
      return parsed.results
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError"
      const isSoft = isTimeout || err instanceof TypeError || err instanceof SyntaxError
      if (!isLast && isSoft) {
        console.warn(`[filter] ${model} ${isTimeout ? "timed out" : "failed"} — trying next model`)
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  throw new Error("All free models exhausted without a successful response")
}

interface UnfilteredRow {
  post_id: string
  content: string
}

async function filterNewPosts(): Promise<void> {
  const unfiltered = db.query<UnfilteredRow, []>(
    "SELECT post_id, content FROM trump_posts WHERE filtered_at IS NULL ORDER BY posted_at DESC"
  ).all()

  if (unfiltered.length === 0) {
    console.log("[filter] No unfiltered posts — skipping")
    return
  }

  console.log(`[filter] Filtering ${unfiltered.length} new posts in batches of ${FILTER_BATCH_SIZE}...`)

  const now = new Date().toISOString()
  let kept = 0
  let deleted = 0
  let errors = 0

  for (let i = 0; i < unfiltered.length; i += FILTER_BATCH_SIZE) {
    const batch = unfiltered.slice(i, i + FILTER_BATCH_SIZE)
    const batchNum = Math.floor(i / FILTER_BATCH_SIZE) + 1
    const totalBatches = Math.ceil(unfiltered.length / FILTER_BATCH_SIZE)

    try {
      const results = await callFilterLLM(batch)

      for (const r of results) {
        if (!r.relevant) {
          db.run("DELETE FROM trump_posts WHERE post_id = ?", [r.post_id])
          deleted++
        } else {
          const summary = r.summary?.trim()
          if (summary) {
            db.run(
              "UPDATE trump_posts SET content = ?, filtered_at = ? WHERE post_id = ?",
              [summary, now, r.post_id]
            )
          } else {
            db.run("UPDATE trump_posts SET filtered_at = ? WHERE post_id = ?", [now, r.post_id])
          }
          kept++
        }
      }

      // Mark any posts the LLM didn't return results for (shouldn't happen, but be safe)
      const returnedIds = new Set(results.map((r) => r.post_id))
      for (const p of batch) {
        if (!returnedIds.has(p.post_id)) {
          db.run("UPDATE trump_posts SET filtered_at = ? WHERE post_id = ?", [now, p.post_id])
          kept++ // keep by default if LLM missed it
        }
      }

      console.log(`[filter] Batch ${batchNum}/${totalBatches}: kept ${results.filter((r) => r.relevant).length}, deleted ${results.filter((r) => !r.relevant).length}`)
    } catch (err) {
      console.error(`[filter] Batch ${batchNum}/${totalBatches} failed:`, err)
      // Mark as filtered with original content so we don't retry endlessly
      for (const p of batch) {
        db.run("UPDATE trump_posts SET filtered_at = ? WHERE post_id = ?", [now, p.post_id])
      }
      errors += batch.length
    }

    // Polite delay between LLM calls
    if (i + FILTER_BATCH_SIZE < unfiltered.length) await Bun.sleep(500)
  }

  const total = (db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM trump_posts").get())?.count ?? 0
  console.log(`[filter] ✅ Done — kept ${kept}, deleted ${deleted}${errors > 0 ? `, ${errors} kept on error` : ""} — ${total} posts remain in DB`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isInit = process.argv.includes("--init")
  const isUpdate = process.argv.includes("--update")

  if (!isInit && !isUpdate) {
    console.error("Usage: bun run scripts/scrape-trump-posts.ts --init | --update")
    process.exit(1)
  }

  let since: Date

  if (isInit) {
    since = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    console.log(`[scraper] INIT mode — fetching posts since ${since.toISOString().slice(0, 10)}`)
  } else {
    const row = db.query<{ max_date: string | null }, []>(
      "SELECT MAX(posted_at) as max_date FROM trump_posts"
    ).get()

    if (row?.max_date) {
      since = new Date(new Date(row.max_date).getTime() - 3600 * 1000)
      console.log(`[scraper] UPDATE mode — fetching posts since ${since.toISOString()} (1h before latest saved)`)
    } else {
      since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      console.log(`[scraper] UPDATE mode (no existing posts) — fetching last 7 days`)
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  })

  try {
    const accountId = await lookupAccountId(browser)
    const maxPosts = isInit ? 15000 : 500
    const posts = await fetchPostsSince(browser, accountId, since, maxPosts)

    console.log(`[scraper] Fetched ${posts.length} posts total`)

    if (posts.length === 0) {
      console.log("[scraper] No new posts to save")
    } else {
      const savedIds = savePosts(posts)
      const skipped = posts.length - savedIds.length
      const total = (db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM trump_posts").get())?.count ?? 0
      console.log(`[scraper] ✅ Saved ${savedIds.length} new posts (${skipped} already existed) — ${total} total in DB`)
    }
  } finally {
    await browser.close()
  }

  // Filter pass — runs on all unfiltered posts (new + any missed from prior runs)
  await filterNewPosts()

  db.close()
}

main().catch((err) => {
  console.error("[scraper] Fatal error:", err)
  process.exit(1)
})
