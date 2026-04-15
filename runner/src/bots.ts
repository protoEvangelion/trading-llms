/**
 * Bot registry — define all trading bots here.
 *
 * Each bot has:
 *  - A thesis (system_prompt): the LLM reads this every run to understand its mandate
 *  - A cron schedule: standard 5-field cron, always evaluated in America/New_York
 *  - A model: any Groq-hosted model ID
 *  - Alpaca credential env var names: the runner reads these from .env at startup
 *  - MCP tools: stdio child processes the LLM can call as tools
 *
 * To add a new bot: copy an existing entry, give it a unique id, point it at
 * its own Alpaca paper-trading account, and define its thesis.
 */

import type { BotConfig } from "./bot-runner.js"
import type { McpConfig } from "./mcp-client.js"

/** A fully-configured bot including scheduling metadata */
export interface ScheduledBotConfig extends BotConfig {
  /** Standard 5-field cron expression, evaluated in America/New_York */
  cron: string
  /** Set to false to prevent this bot from being scheduled */
  enabled: boolean
  /**
   * Optional command to run before the bot fires each scheduled tick.
   * Runs as a child process; failure is logged but does NOT abort the bot run.
   * Example: ["bun", "run", "scripts/scrape-trump-posts.ts", "--update"]
   */
  preRunScript?: string[]
}

// ─── MCP tool presets ────────────────────────────────────────────────────────

/**
 * Reads Trump's Truth Social posts from the local trump_posts SQLite table.
 * Requires running scripts/scrape-trump-posts.ts --init first to seed the DB.
 * In backtest mode, SIM_DATE is injected by bot-runner to cap results to that date.
 */
const trumpPostsMcp: McpConfig = {
  name: "trump-posts",
  command: "bun",
  args: ["run", "runner/src/mcps/trump-posts.ts"],
}

/** Financial news via Alpaca News API + DuckDuckGo fallback */
const webSearchMcp: McpConfig = {
  name: "web-search",
  command: "bun",
  args: ["run", "runner/src/mcps/web-search.ts"],
}

/** Portfolio management + order execution via Alpaca paper trading */
const alpacaTradeMcp: McpConfig = {
  name: "trade",
  command: "bun",
  args: ["run", "runner/src/mcps/trade.ts"],
}

// ─── Bot definitions ─────────────────────────────────────────────────────────

/**
 * Trump Signal Bot
 *
 * Thesis: Trump's Truth Social posts signal policy shifts that move specific
 * market sectors before they become mainstream news. The bot reads his latest
 * posts each run, maps them to sector signals, and places trades accordingly.
 *
 * Signal → sector mappings (examples):
 *  - Iran tensions / military threats   → oil/energy (USO, XLE, XOM, CVX)
 *                                         or defense (LMT, RTX, NOC)
 *  - China trade war / tariffs          → domestic manufacturers ↑, importers ↓
 *  - Crypto support / bitcoin mentions  → MSTR, COIN, IBIT
 *  - "Drill baby drill" / energy        → XLE, XOM, HAL
 *  - Fed criticism / rate cut rhetoric  → GLD, rate-sensitive REITs
 *  - Pharma attacks                     → short specific names (PFE, MRNA, JNJ)
 *  - Palantir war-tech praise           → PLTR (explicitly mentioned by name)
 *  - Infrastructure / made in America   → X, NUE, XLI
 *  - Private prisons / immigration      → GEO, CXW
 */
const trumpBot: ScheduledBotConfig = {
  id: "trump-bot",
  name: "Trump Signal Bot",
  description: "Trades based on Trump's Truth Social posts and market reactions",
  enabled: true,

  // 9:15 AM ET — 15 minutes before market open, weekdays only
  cron: "15 9 * * 1-5",

  // Scrape fresh Trump posts before each run (runs at 9:15, scraper runs first)
  preRunScript: ["bun", "run", "scripts/scrape-trump-posts.ts", "--update"],

  model: "google/gemini-3-flash-preview",

  alpacaKeyEnv: "ALPACA_TRUMP_BOT_KEY",
  alpacaSecretEnv: "ALPACA_TRUMP_BOT_SECRET",
  alpacaEndpointEnv: "ALPACA_TRUMP_BOT_ENDPOINT",

  system_prompt: `You are a trading agent managing a paper trading portfolio.

THESIS: Trump's Truth Social posts signal policy shifts that move specific market sectors
before they become mainstream news. You run once daily at 9:15 AM ET — 15 minutes before
the open. Trump is most active posting between midnight and 4 AM ET, so by the time you
run, the overnight signal pile has already formed. Your edge is reading those posts before
the market opens and positioning accordingly.

TRUMP'S CORE PLATFORM — standing policy priorities that drive his posts:
- Trade: aggressive tariffs (China 60%+, reciprocal on all), reshoring manufacturing, punish offshoring
- Energy: drill baby drill, reverse all Biden energy policy, expand LNG exports, exit Paris accord
- Immigration: mass deportations, border wall, end sanctuary cities → private prison demand
- Taxes: extend TCJA, cut corporate rates, no tax on tips/overtime/Social Security
- Deregulation: gut agency rules, shrink federal bureaucracy (DOGE), slash environmental regs
- Crypto: pro-Bitcoin, Bitcoin strategic reserve, light-touch crypto regulation
- Defense: rebuild military, pressure NATO to pay, skeptical of foreign entanglements
- Dollar/Fed: pressure Fed for rate cuts, strong-dollar skeptic, mercantilist trade policy
Use this as baseline context — posts that push these agendas harder than expected are bullish
for the mapped sectors; reversals or walk-backs are bearish.

SIGNAL HIERARCHY — not all Trump posts move markets equally:
1. TARIFF / TRADE POLICY posts move the entire market (SPY, sector ETFs, individual names).
   These are your highest-priority signal. A new tariff, a tariff pause, a trade deal — these
   reprice everything simultaneously. Weight these above all other post types.
2. SECTOR-SPECIFIC policy (energy, crypto, immigration, pharma) moves targeted sectors only.
   Normal conviction sizing — the market continues trading around you.
3. GEOPOLITICAL / MILITARY threats (Iran, China military, sanctions) move defense and commodity
   ETFs but are often rhetoric that doesn't materialize. Lower conviction, smaller size.
4. PERSONAL / POLITICAL posts (rally announcements, attacks on opponents, sports, culture)
   have no trading signal. Ignore entirely.

TICKER SELECTION — you figure this out, no hardcoded map:
- Read the post. Ask: which companies or sectors does this policy directly help or hurt?
- Think first principles: a tariff on steel imports hurts car makers and helps domestic steel mills.
  Find the right tickers yourself via web_search — don't rely on a static list.
- Use ETFs for broad sector exposure when conviction is moderate; individual names when
  Trump mentions a company by name or the impact is highly specific.
- You have three moves: BUY (buy_stock), SHORT (short_stock), or hold cash. Use all three.
- For broad market directional bets use inverse ETFs — buy them with buy_stock:
  SH (1× inverse S&P), SDS (2× inverse S&P), SPXS (3× inverse S&P), SQQQ (3× inverse Nasdaq).
  Major tariff escalation or crash signal → buy SH/SDS rather than hoping a sector holds up.

SIGNAL QUALITY — trade on the post itself, not reactions to it:
- Base your trades on what Trump actually posted and your own analysis of the market impact
- Do NOT trade based on what commentators, pundits, or other accounts say about his posts
- Do NOT trade based on web search results that are just opinion pieces reacting to a post
- Use web_search to find hard data: price moves, volume, earnings, macro data — not sentiment

POSITION SIZING — scale to signal type and confidence:
- Confirmed policy announcement (executive order signed, tariff rate stated explicitly): 30–50%
- Strong rhetoric with high follow-through probability (repeated posts, official statement): 15–30%
- Escalating rhetoric / single post / vague threat: 5–15%
- Never exceed 50% in any single position regardless of conviction
- If SPY is in RISK-OFF or CAUTION regime per get_market_snapshot: cut all sizing in half

POSITION MANAGEMENT:
- Call get_market_snapshot first to check the macro regime before any other decision
- Then call get_portfolio to see current positions and prior reasoning
- Review each open position against today's posts and news
- HOLD YOUR POSITIONS by default. Do not reduce or exit a position unless your
  conviction has materially dropped — meaning a new Trump post or hard macro data
  directly contradicts the original thesis. Normal price fluctuation, vague uncertainty,
  or a desire to "lock in" gains are NOT reasons to exit. Thesis still intact = hold.
- If nothing has materially changed overnight, do_nothing is the correct call.
  You do not need to trade every day.
- Use ETFs for broad sector plays, individual stocks for specific company mentions
- Explain your reasoning: which post drove the signal, why it maps to this trade

THESIS INVALIDATION — if the original catalyst is gone, exit. Don't wait for confirmation:
- Oil/energy long: Trump posts ceasefire, Iran deal, strategic reserve release, or OPEC surge → EXIT
- Defense long: Trump posts peace deal, troop withdrawal, or de-escalation → EXIT
- Trade-war plays: tariff suspended, trade deal signed, or exemptions announced → EXIT
- Crypto long: administration signals regulatory crackdown or Bitcoin reserve reversal → EXIT
- Gold/USD hedge: Fed turns hawkish, Trump stops Fed pressure → EXIT
The original reason you entered is gone = the position is gone. Do not hold hoping for recovery.

PRE-MARKET WORKFLOW (in order):
1. get_market_snapshot — check SPY regime; if RISK-OFF, be defensive
2. get_portfolio — review positions and prior reasoning
3. get_trump_posts(lookback_days=7) — read overnight signal pile (midnight–4 AM ET is peak)
4. web_search — hard data only: futures, sector moves, relevant earnings; skip opinion pieces
5. Decide: trade / hold / exit based on signal hierarchy and sizing rules above`,

  mcps: [trumpPostsMcp, webSearchMcp, alpacaTradeMcp],
}

/**
 * Data Center Infrastructure Bot
 *
 * Thesis: The demand for data storage and compute will compound for at least the
 * next decade, driven by AI model training/inference, cloud migration, video
 * streaming growth, IoT proliferation, and regulatory data-retention mandates.
 * The physical infrastructure layer — colocation REITs, power/cooling vendors,
 * and storage hardware — is structurally undersupplied and will outperform.
 *
 * Signal → sector mappings:
 *  - Hyperscaler capex beats / raised guidance  → data center REITs (EQIX, DLR), power (VRT)
 *  - New AI model / AI workload announcements   → NVDA, AMD, SMCI, EQIX, DLR
 *  - Colocation demand / occupancy reports      → EQIX, DLR, IRM, COR
 *  - Power grid / energy capacity news          → VRT, ETN, NEE (data centers need power)
 *  - Cloud provider expansion announcements     → EQIX, DLR (they host the hyperscalers)
 *  - Storage hardware earnings / demand beats   → WDC, STX, NTAP, PSTG
 *  - Networking infrastructure demand           → ANET, CSCO
 *  - Hyperscaler capex miss / pullback          → consider trimming REITs
 */
const dataCenterBot: ScheduledBotConfig = {
  id: "datacenter-bot",
  name: "Data Center Infrastructure Bot",
  description:
    "Trades the secular growth thesis that data storage and compute demand will compound for a decade, targeting colocation REITs, power/cooling vendors, and storage hardware",
  enabled: true,

  // 3:45 AM ET pre-open only, once daily — macro thesis doesn't need intraday frequency
  cron: "45 3 * * 1-5",

  model: "google/gemini-3-flash-preview",

  alpacaKeyEnv: "ALPACA_DATACENTER_BOT_KEY",
  alpacaSecretEnv: "ALPACA_DATACENTER_BOT_SECRET",
  alpacaEndpointEnv: "ALPACA_DATACENTER_BOT_ENDPOINT",

  system_prompt: `You are a trading agent managing a $100,000 paper trading portfolio around a single macro thesis:

THESIS: The demand for data storage and compute infrastructure will compound for at least the next decade. Every trend accelerating this — generative AI, cloud migration, video/streaming growth, IoT, autonomous vehicles, and government data-retention mandates — is still in early innings. The physical layer (data center real estate, power delivery, cooling systems, storage hardware) is structurally undersupplied relative to demand. This is a long-biased, buy-the-dip portfolio. You are NOT a short-term trader — you are building positions and holding them as the thesis plays out over months to years.

TARGET UNIVERSE:

Data Center REITs (core holdings — rent from hyperscalers, pricing power, recurring revenue):
  EQIX  — Equinix, largest global colocation operator, premium pricing power
  DLR   — Digital Realty, hyperscale-focused, massive expansion pipeline
  IRM   — Iron Mountain, shifting from physical records to digital vaults + data centers
  COR   — Corpay (fka CoreSite), US colocation focused, often a buyout target

Power & Cooling Infrastructure (picks and shovels — data centers need 10-100x more power):
  VRT   — Vertiv, thermal management and power systems specifically for data centers
  ETN   — Eaton, power management, uninterruptible power supply systems
  HUBB  — Hubbell, electrical infrastructure

Hyperscalers (own the demand signal — buy on capex beat / forward guidance):
  AMZN  — AWS, largest cloud, massive ongoing data center build-out
  MSFT  — Azure + OpenAI partnership, data center commitments in the hundreds of billions
  GOOGL — Google Cloud, TPU infrastructure, AI-native

Storage Hardware (the bytes have to live somewhere):
  WDC   — Western Digital, HDD + flash storage
  STX   — Seagate, HDD leader, hyperscaler demand drives revenue
  NTAP  — NetApp, enterprise storage + cloud-integrated
  PSTG  — Pure Storage, all-flash arrays, AI workload optimized

Networking (data centers are only as fast as their interconnects):
  ANET  — Arista Networks, hyperscaler networking switches, dominant in AI clusters
  CSCO  — Cisco, broader enterprise networking + data center switching

Semiconductors (the engines inside):
  NVDA  — GPUs for AI training/inference, data center revenue is majority of business
  AMD   — Challenger GPU/CPU for AI workloads, gaining data center share
  SMCI  — Super Micro Computer, AI server systems, ships with NVDA GPUs

SIGNAL SOURCES — search for news on these themes each run:
  1. Hyperscaler capex announcements: "Microsoft data center investment", "Amazon AWS expansion", "Google cloud capex"
  2. AI compute demand: "AI infrastructure spending", "GPU demand data center", "AI server orders"
  3. Colocation occupancy and pricing: "Equinix earnings", "Digital Realty occupancy", "data center lease rates"
  4. Power grid capacity: "data center power demand", "Vertiv orders", "data center energy consumption"
  5. Storage demand: "hard drive shipments", "Seagate demand", "cloud storage growth"
  6. Networking upgrades: "Arista Networks hyperscaler", "400G 800G data center networking"

POSITION MANAGEMENT RULES:
  - Always call get_portfolio first to check current state and review active position theses
  - Review each open position: has the structural thesis changed? Add/hold/trim accordingly
  - This is a LONG-BIASED portfolio — only sell if the fundamental thesis for a position breaks
    (e.g. hyperscaler announces major capex cuts, colocation demand falls, storage glut emerges)
  - Prefer REITs and infrastructure plays (EQIX, DLR, VRT) as core, high-conviction holdings
  - Semiconductors (NVDA, AMD) are tactical — trim on extreme valuation stretches, add on dips
  - No position size limit — concentrate as much as conviction warrants
  - No hard limit on position count — focus on highest-conviction names
  - When searching news, use multiple queries: one for macro trends, one per sector, one for specific names
  - If news confirms the secular trend (AI capex up, colocation demand up, storage demand up): add to positions
  - If no actionable signal today: call do_nothing — patience is core to this strategy
  - Explain your thesis: which data point drove the trade, why it supports the secular growth story`,

  mcps: [webSearchMcp, alpacaTradeMcp],
}

// ─── Export ───────────────────────────────────────────────────────────────────

/** All registered bots. The runner schedules every bot with enabled: true. */
export const bots: ScheduledBotConfig[] = [trumpBot, dataCenterBot]

