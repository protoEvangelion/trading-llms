import { scheduleBot, triggerBotNow, stopAll } from "./scheduler.js"
import { getDb } from "./db.js"
import { bots } from "./bots.js"
import { runBacktest } from "./backtest-runner.js"
import { writeFileSync } from "fs"

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

  // Resolve TRADING_ENV before the first getDb() call so the right DB file is opened.
  // --backtest always forces dev. --env= overrides. Default is staging.
  const envArg = process.argv.find((a) => a.startsWith("--env="))
  const isBacktest = process.argv.some((a) => a.startsWith("--backtest="))
  if (isBacktest) {
    process.env.TRADING_ENV = "dev"
  } else if (envArg) {
    const val = envArg.split("=")[1]
    if (!["dev", "staging", "prod"].includes(val)) {
      console.error(`Invalid --env value "${val}". Must be dev | staging | prod.`)
      process.exit(1)
    }
    process.env.TRADING_ENV = val
  } else {
    process.env.TRADING_ENV ??= "staging"
  }

  console.log(`[runner] env: ${process.env.TRADING_ENV}`)

  // Ensure DB is initialized (runs migrations)
  getDb()

  // Write bots.json so the webapp can read bot metadata without importing the runner
  const botsJsonPath = new URL("../../bots.json", import.meta.url).pathname
  const botsJson = {
    bots: bots.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description ?? "",
      model: b.model,
      cron: b.cron,
      system_prompt: b.system_prompt,
    })),
  }
  writeFileSync(botsJsonPath, JSON.stringify(botsJson, null, 2))
  console.log(`[runner] wrote bots.json (${bots.length} bots)`)

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

  // --init=<botId>  — initialization run with extended lookback, forces a trade
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
    }

    await triggerBotNow(botId, [initBot])
    process.exit(0)
  }

  // --backtest=<botId> --start=YYYY-MM-DD --end=YYYY-MM-DD
  const backtestArg = process.argv.find((a) => a.startsWith("--backtest="))
  if (backtestArg) {
    const botId = backtestArg.split("=")[1]
    const bot = bots.find((b) => b.id === botId)
    if (!bot) {
      console.error(`Bot ${botId} not found`)
      process.exit(1)
    }

    const startArg = process.argv.find((a) => a.startsWith("--start="))
    const endArg = process.argv.find((a) => a.startsWith("--end="))

    if (!startArg || !endArg) {
      console.error("--backtest requires --start=YYYY-MM-DD and --end=YYYY-MM-DD")
      process.exit(1)
    }

    const startDate = startArg.split("=")[1]
    const endDate = endArg.split("=")[1]

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      console.error("Dates must be in YYYY-MM-DD format")
      process.exit(1)
    }

    if (startDate >= endDate) {
      console.error("--start must be before --end")
      process.exit(1)
    }

    console.log(`--backtest flag detected: running ${botId} from ${startDate} to ${endDate}\n`)

    try {
      await runBacktest(bot, startDate, endDate)
    } catch (err) {
      console.error("Backtest failed:", err)
      process.exit(1)
    }

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
