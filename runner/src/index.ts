import { scheduleBot, triggerBotNow, stopAll } from "./scheduler.js"
import { getDb } from "./db.js"
import { bots } from "./bots.js"

// Load .env from project root
const envFile = Bun.file(new URL("../../.env", import.meta.url))
if (await envFile.exists()) {
  const content = await envFile.text()
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const [key, ...rest] = trimmed.split("=")
    if (key && rest.length > 0) process.env[key.trim()] = rest.join("=").trim()
  }
}

async function main() {
  console.log("🤖 Trading bot runner starting...\n")

  // Set absolute data dir so db.ts resolves correctly regardless of cwd
  process.env.TRADING_BOTS_DATA_DIR = new URL("../../data", import.meta.url).pathname

  // Ensure DB is initialized (runs migrations)
  getDb()

  const enabledBots = bots.filter((b) => b.enabled)
  console.log(`Loaded ${bots.length} bots (${enabledBots.length} enabled)\n`)

  // --run-now=<botId>  — trigger one bot immediately then exit
  const runNowArg = process.argv.find((a) => a.startsWith("--run-now="))
  if (runNowArg) {
    const botId = runNowArg.split("=")[1]
    console.log(`--run-now flag detected: triggering ${botId} immediately\n`)
    await triggerBotNow(botId, bots)
    process.exit(0)
  }

  // --init=<botId>  — initialization run: fetch 30 days of posts, force an action
  const initArg = process.argv.find((a) => a.startsWith("--init="))
  if (initArg) {
    const botId = initArg.split("=")[1]
    const bot = bots.find((b) => b.id === botId)
    if (!bot) {
      console.error(`Bot ${botId} not found`)
      process.exit(1)
    }

    console.log(`--init flag detected: running ${botId} with 30-day lookback\n`)

    const initBot = {
      ...bot,
      system_prompt:
        bot.system_prompt +
        `\n\nIMPORTANT — INITIALIZATION RUN: You are reviewing the last 30 days of posts. ` +
        `Analyze the full month for dominant themes and signals. ` +
        `You MUST take at least one position based on what you find — do NOT call do_nothing. ` +
        `Look especially for: geopolitical tensions (Iran, Middle East → oil/defense), ` +
        `trade policy (tariffs → sector rotation), regulatory announcements (crypto, energy), ` +
        `and any sector-specific signals. Make a bold thesis-driven trade.`,
      mcps: bot.mcps.map((mcp) =>
        mcp.name === "truth-social"
          ? {
              ...mcp,
              env: {
                ...mcp.env,
                TRUTH_SOCIAL_DEFAULT_LOOKBACK: "720",
                TRUTH_SOCIAL_DEFAULT_MAX_POSTS: "300",
              },
            }
          : mcp,
      ),
    }

    await triggerBotNow(botId, [initBot])
    process.exit(0)
  }

  // Schedule all enabled bots
  for (const bot of bots) {
    scheduleBot(bot)
  }

  console.log("\n✅ All bots scheduled. Runner is live.\n")

  process.on("SIGINT", () => {
    console.log("\nShutting down...")
    stopAll()
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    stopAll()
    process.exit(0)
  })

  // Keep process alive
  await new Promise<never>(() => {})
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
