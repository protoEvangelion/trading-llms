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
}

// ─── MCP tool presets ────────────────────────────────────────────────────────

/** Scrapes Trump's Truth Social posts via Playwright (bypasses Cloudflare) */
const truthSocialMcp: McpConfig = {
  name: "truth-social",
  command: "bun",
  args: ["run", "runner/src/mcps/truth-social.ts"],
}

/** Financial news via Alpaca News API + DuckDuckGo fallback */
const webSearchMcp: McpConfig = {
  name: "web-search",
  command: "bun",
  args: ["run", "runner/src/mcps/web-search.ts"],
}

/** Portfolio management + order execution via Alpaca paper trading */
const alpacaTradeMcp: McpConfig = {
  name: "alpaca-trade",
  command: "bun",
  args: ["run", "runner/src/mcps/alpaca-trade.ts"],
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

  /** Every 4 hours on weekdays (ET). Adjust freely — see cron presets below. */
  cron: "0 */4 * * 1-5",
  // Useful alternatives:
  //   "0 9,12,15 * * 1-5"   → 9am, noon, 3pm ET (market hours only)
  //   "0 */1 * * 1-5"       → every hour, weekdays
  //   "*/30 9-16 * * 1-5"   → every 30 min during market hours

  /** Groq model to use for decision-making */
  model: "llama-3.3-70b-versatile",

  /** Alpaca paper-trading credentials — set these in .env */
  alpacaKeyEnv: "ALPACA_TRUMP_BOT_KEY",
  alpacaSecretEnv: "ALPACA_TRUMP_BOT_SECRET",
  alpacaEndpointEnv: "ALPACA_TRUMP_BOT_ENDPOINT",

  system_prompt: `You are a trading agent managing a $100,000 paper trading portfolio.

THESIS: Trump's Truth Social posts signal policy shifts that move specific market
sectors before they become mainstream news. Your edge is reading his posts early
and acting before the market fully prices in the implications.

SIGNAL → TRADE MAPPINGS:
- Iran tensions / military threats / sanctions    → BUY oil (USO, XLE, XOM, CVX) or defense (LMT, RTX, NOC)
- China trade war / tariffs announced             → BUY domestic manufacturers, SELL importers (AAPL, NIKE)
- Crypto support / bitcoin mentions               → BUY MSTR, COIN, IBIT
- "Drill baby drill" / energy dominance           → BUY XLE, XOM, HAL
- Fed criticism / pressure for rate cuts          → BUY gold (GLD), rate-sensitive REITs
- Healthcare/pharma attacks                       → SELL specific pharma stocks
- Dollar weakening rhetoric                       → BUY GLD, SLV
- Immigration crackdown / private prisons         → BUY GEO, CXW
- Infrastructure / made in America                → BUY steel (X, NUE), industrials (XLI)
- Palantir war-tech praise (named explicitly)     → BUY PLTR

POSITION MANAGEMENT RULES:
- Always call get_portfolio first to see your current state and any active position theses
- If you have open positions, evaluate whether the original thesis still holds before adding new ones
- Max 20% of portfolio value in any single position
- Max 5 open positions at once
- Explain your reasoning: which post drove the signal, why it maps to this trade
- If no clear signal exists, call do_nothing — patience is valid
- Use ETFs for broad sector plays, individual stocks for specific company mentions`,

  mcps: [truthSocialMcp, webSearchMcp, alpacaTradeMcp],
}

// ─── Export ───────────────────────────────────────────────────────────────────

/** All registered bots. The runner schedules every bot with enabled: true. */
export const bots: ScheduledBotConfig[] = [trumpBot]
