import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs"
import { join, resolve } from "path"
import { bots } from "../bots.js"
import type { ScheduledBotConfig } from "../bots.js"
import { getDb } from "../db.js"
import { buildReasoningStandardSection } from "../prompting.js"
import {
  calculateMaxDrawdown,
  getTradingDays,
  makeStateFilePath,
} from "../simulation.js"
import { getHarnessAdapter, type HarnessName, type McpServerSpec } from "./harnesses/index.js"

const STARTING_CASH = 100_000

interface HarnessRunRow {
  id: number
  harness_session_id: string | null
  model: string
  sim_start: string | null
  sim_end: string | null
}

interface HarnessPnlRow {
  portfolio_value: number
  spy_value: number | null
  sim_date: string
}

export interface HarnessRunConfig {
  harness: HarnessName
  model: string
  botId: string
  mode: "backtest" | "paper" | "live"
  startDate?: string
  endDate?: string
  resume: boolean
}

export async function runHarness(config: HarnessRunConfig): Promise<void> {
  const bot = resolveBot(config.botId)
  if (!bot) {
    throw new Error(
      `Bot "${config.botId}" not found. Available bot IDs: ${bots.map((candidate) => candidate.id).join(", ")}`
    )
  }

  const db = getDb()
  const dataDir = process.env.TRADING_BOTS_DATA_DIR ?? resolve(import.meta.dir, "../../../data")
  const projectRoot = resolve(import.meta.dir, "../../..")
  mkdirSync(dataDir, { recursive: true })

  let existingRun: HarnessRunRow | null = null
  if (config.resume) {
    existingRun = db
      .query<HarnessRunRow, [string, string, string]>(
        `SELECT id, harness_session_id, model, sim_start, sim_end
         FROM runs
         WHERE bot_id = ? AND harness = ? AND mode = ? AND status = 'running'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(bot.id, config.harness, config.mode) ?? null
  }

  const isResuming = existingRun !== null
  if (isResuming) {
    const resumedRun = existingRun!
    config.startDate = resumedRun.sim_start ?? config.startDate
    config.endDate = resumedRun.sim_end ?? config.endDate

    if (config.mode === "backtest") {
      if (!config.startDate || !config.endDate) {
        throw new Error(`Run ${resumedRun.id} is missing its stored backtest range`)
      }
      if ((resumedRun.sim_start && resumedRun.sim_start !== config.startDate) || (resumedRun.sim_end && resumedRun.sim_end !== config.endDate)) {
        throw new Error(
          `Resume range mismatch for run ${resumedRun.id}: stored ${resumedRun.sim_start} → ${resumedRun.sim_end}, got ${config.startDate} → ${config.endDate}`
        )
      }
    }

    if (resumedRun.model && resumedRun.model !== config.model) {
      throw new Error(
        `Resume model mismatch for run ${resumedRun.id}: stored ${resumedRun.model}, got ${config.model}`
      )
    }
  } else if (config.resume) {
    console.log(`[harness] No running ${config.harness} session found for ${bot.id} / ${config.mode}; starting fresh`)
  }

  if (config.mode === "backtest" && (!config.startDate || !config.endDate)) {
    throw new Error("Backtest mode requires startDate and endDate")
  }

  let runId: number
  if (isResuming) {
    const resumedRun = existingRun!
    runId = resumedRun.id
    console.log(`[harness] Resuming run ${runId} for ${bot.id} (${config.harness}/${config.mode})`)
  } else {
    db.run(
      `INSERT INTO runs (bot_id, harness, model, mode, started_at, sim_start, sim_end, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      [
        bot.id,
        config.harness,
        config.model,
        config.mode,
        new Date().toISOString(),
        config.startDate ?? null,
        config.endDate ?? null,
      ],
    )
    runId = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
    console.log(`[harness] Created run ${runId} for ${bot.id}`)
  }

  const workingDir = join("/tmp", `trading-harness-${runId}`)
  const simClockFile = join(dataDir, `${runId}-sim-clock.json`)
  const backtestStateFile = config.mode === "backtest" ? makeStateFilePath(dataDir, runId) : null
  const logFile = makeLogFilePath(dataDir, runId, bot, config)

  mkdirSync(workingDir, { recursive: true })
  mkdirSync(join(dataDir, "logs"), { recursive: true })

  if (!isResuming) {
    const tradingDays = await initializeRunState({
      bot,
      config,
      runId,
      simClockFile,
      backtestStateFile,
      logFile,
    })

    if (config.mode === "backtest") {
      config.startDate = tradingDays[0]
      config.endDate = tradingDays[tradingDays.length - 1]
      db.run(`UPDATE runs SET sim_start = ?, sim_end = ? WHERE id = ?`, [config.startDate, config.endDate, runId])
    }
  }

  const mcpServers = buildBotMcpConfigs({
    bot,
    config,
    projectRoot,
    runId,
    simClockFile,
    backtestStateFile,
    logFile,
  })

  const adapter = getHarnessAdapter(config.harness)
  const contextDoc = buildContextDoc(bot, config)
  const initialPrompt = buildInitialPrompt(bot, config, isResuming)

  console.log(`\n[harness] Launching ${config.harness} for "${bot.name}" (run ${runId})`)
  console.log(`[harness] Working dir: ${workingDir}`)
  console.log(`[harness] Log: ${logFile}\n`)

  const session = await adapter.launch({
    model: config.model,
    workingDir,
    contextDoc,
    mcpServers,
    initialPrompt,
    resuming: isResuming,
    sessionId: existingRun?.harness_session_id ?? undefined,
  })

  if (session.sessionId) {
    db.run(`UPDATE runs SET harness_session_id = ? WHERE id = ?`, [session.sessionId, runId])
  }

  const stopHarness = (signal: NodeJS.Signals) => {
    if (!session.process.killed) {
      console.log(`\n[harness] Forwarding ${signal} to ${config.harness}`)
      session.process.kill(signal)
    }
  }

  process.on("SIGINT", stopHarness)
  process.on("SIGTERM", stopHarness)

  let exitCode: number
  try {
    exitCode = await session.waitForExit()
  } finally {
    process.off("SIGINT", stopHarness)
    process.off("SIGTERM", stopHarness)
  }

  if (config.mode === "backtest") {
    if (exitCode !== 0) {
      db.run(`UPDATE runs SET status = 'failed', completed_at = ? WHERE id = ?`, [new Date().toISOString(), runId])
      appendRunLog(logFile, `Run failed with exit code ${exitCode}.`)
      cleanupTerminalRunFiles(workingDir, simClockFile, backtestStateFile)
      process.exit(exitCode)
    }

    const metrics = finalizeBacktestRun(runId)
    appendRunLog(
      logFile,
      `Final return: ${(metrics.totalReturn * 100).toFixed(2)}%\nSPY return: ${(metrics.spyReturn * 100).toFixed(2)}%\nMax drawdown: ${(metrics.maxDrawdown * 100).toFixed(2)}%`
    )
    cleanupTerminalRunFiles(workingDir, simClockFile, backtestStateFile)

    console.log(`\n[harness] Run ${runId} completed ✅`)
    console.log(`  Total Return: ${(metrics.totalReturn * 100).toFixed(2)}%`)
    console.log(`  SPY Return:   ${(metrics.spyReturn * 100).toFixed(2)}%`)
    console.log(`  Max Drawdown: ${(metrics.maxDrawdown * 100).toFixed(2)}%`)
    return
  }

  if (exitCode === 0) {
    appendRunLog(logFile, `Harness exited cleanly. Run remains in 'running' state for future resume.`)
    console.log(`\n[harness] ${config.mode} session exited cleanly and can be resumed later.`)
    return
  }

  db.run(`UPDATE runs SET status = 'failed', completed_at = ? WHERE id = ?`, [new Date().toISOString(), runId])
  appendRunLog(logFile, `Harness exited unexpectedly with code ${exitCode}.`)
  cleanupTerminalRunFiles(workingDir, simClockFile, backtestStateFile)
  process.exit(exitCode)
}

function resolveBot(botId: string): ScheduledBotConfig | undefined {
  const normalized = botId.trim().toLowerCase()
  return bots.find((bot) => {
    const exact = bot.id.toLowerCase()
    const alias = exact.endsWith("-bot") ? exact.slice(0, -4) : exact
    return exact === normalized || alias === normalized
  })
}

async function initializeRunState(params: {
  bot: ScheduledBotConfig
  config: HarnessRunConfig
  runId: number
  simClockFile: string
  backtestStateFile: string | null
  logFile: string
}): Promise<string[]> {
  const { bot, config, runId, simClockFile, backtestStateFile, logFile } = params

  let tradingDays: string[] = []
  let startDate = config.startDate
  let endDate = config.endDate

  if (config.mode === "backtest") {
    const alpacaKey = process.env[bot.alpacaKeyEnv]
    const alpacaSecret = process.env[bot.alpacaSecretEnv]

    if (!alpacaKey || !alpacaSecret) {
      throw new Error(`Missing Alpaca credentials for ${bot.id}: ${bot.alpacaKeyEnv} / ${bot.alpacaSecretEnv}`)
    }

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const cappedEndDate = endDate! > yesterday.toISOString().slice(0, 10)
      ? yesterday.toISOString().slice(0, 10)
      : endDate!

    if (cappedEndDate !== endDate) {
      console.log(`[harness] endDate ${endDate} capped to ${cappedEndDate}`)
    }

    console.log(`[harness] Fetching trading calendar ${startDate} → ${cappedEndDate}...`)
    tradingDays = await getTradingDays(startDate!, cappedEndDate, alpacaKey, alpacaSecret)
    if (tradingDays.length === 0) throw new Error("No trading days found in the requested backtest range")

    startDate = tradingDays[0]
    endDate = tradingDays[tradingDays.length - 1]

    if (!backtestStateFile) throw new Error("Backtest state file was not created")
    writeFileSync(
      backtestStateFile,
      JSON.stringify({
        runId,
        botId: bot.id,
        simDate: startDate,
        cash: STARTING_CASH,
        startingCash: STARTING_CASH,
        positions: {},
        orders: [],
      }, null, 2),
      "utf8"
    )
  }

  writeFileSync(
    simClockFile,
    JSON.stringify({
      runId,
      mode: config.mode,
      tradingDays,
      currentDayIndex: 0,
      completed: false,
    }, null, 2),
    "utf8"
  )

  writeFileSync(
    logFile,
    [
      `# ${bot.name} — ${config.harness} — ${config.mode} — run ${runId}`,
      ``,
      `**Started:** ${new Date().toISOString()}`,
      startDate && endDate ? `**Period:** ${startDate} → ${endDate}` : "",
      `**Starting cash:** $${STARTING_CASH.toLocaleString()}`,
      `**Harness:** ${config.harness}${config.model ? ` / ${config.model}` : ""}`,
      ``,
    ].filter(Boolean).join("\n") + "\n",
    "utf8"
  )

  return tradingDays
}

function buildBotMcpConfigs(params: {
  bot: ScheduledBotConfig
  config: HarnessRunConfig
  projectRoot: string
  runId: number
  simClockFile: string
  backtestStateFile: string | null
  logFile: string
}): Record<string, McpServerSpec> {
  const { bot, config, projectRoot, runId, simClockFile, backtestStateFile, logFile } = params
  const tradingEnv = config.mode === "live" ? "prod" : config.mode === "backtest" ? "dev" : "staging"
  const runnerSrcDir = resolve(import.meta.dir, "..")

  const servers: Record<string, McpServerSpec> = {
    "sim-clock": {
      command: "bun",
      args: ["run", join(runnerSrcDir, "harness-mode/mcps/sim-clock.ts")],
      env: {
        SIM_CLOCK_STATE_FILE: simClockFile,
        HARNESS_LOG_FILE: logFile,
        HARNESS_BOT_ID: bot.id,
        TRADING_BOTS_DATA_DIR: process.env.TRADING_BOTS_DATA_DIR ?? "",
        ...(backtestStateFile ? {
          BACKTEST_STATE_FILE: backtestStateFile,
          ALPACA_KEY: process.env[bot.alpacaKeyEnv] ?? "",
          ALPACA_SECRET: process.env[bot.alpacaSecretEnv] ?? "",
        } : {}),
      },
    },
  }

  for (const mcp of bot.mcps) {
    if (mcp.name === "trade" && config.mode === "backtest") {
      if (!backtestStateFile) throw new Error("Missing backtest state file for backtest-trade MCP")
      servers["backtest-trade"] = {
        command: "bun",
        args: ["run", join(runnerSrcDir, "mcps/backtest-trade.ts")],
        env: {
          BACKTEST_STATE_FILE: backtestStateFile,
          SIM_CLOCK_STATE_FILE: simClockFile,
          ALPACA_KEY: process.env[bot.alpacaKeyEnv] ?? "",
          ALPACA_SECRET: process.env[bot.alpacaSecretEnv] ?? "",
          TRADING_BOTS_DATA_DIR: process.env.TRADING_BOTS_DATA_DIR ?? "",
        },
      }
      continue
    }

    if (mcp.name === "trade") {
      servers.trade = {
        command: mcp.command,
        args: resolveMcpArgs(projectRoot, mcp.args ?? []),
        env: {
          ...mcp.env,
          ALPACA_KEY: process.env[bot.alpacaKeyEnv] ?? "",
          ALPACA_SECRET: process.env[bot.alpacaSecretEnv] ?? "",
          ALPACA_ENDPOINT: process.env[bot.alpacaEndpointEnv] ?? "",
          TRADING_BOTS_DATA_DIR: process.env.TRADING_BOTS_DATA_DIR ?? "",
          TRADING_ENV: tradingEnv,
          HARNESS_BOT_ID: bot.id,
          HARNESS_RUN_ID: String(runId),
          HARNESS_MODE: config.mode,
        },
      }
      continue
    }

    servers[mcp.name] = {
      command: mcp.command,
      args: resolveMcpArgs(projectRoot, mcp.args ?? []),
      env: {
        ...mcp.env,
        SIM_CLOCK_STATE_FILE: simClockFile,
        TRADING_BOTS_DATA_DIR: process.env.TRADING_BOTS_DATA_DIR ?? "",
      },
    }
  }

  return servers
}

function buildContextDoc(bot: ScheduledBotConfig, config: HarnessRunConfig): string {
  const isBacktest = config.mode === "backtest"
  const toolLines = buildToolDocs(bot, config)
  const reasoningStandard = buildReasoningStandardSection()

  return `# ${bot.name}

## Investment Thesis
${bot.system_prompt}

${reasoningStandard}

## Harness Protocol
You are running inside a long-lived ${config.harness} harness.
${isBacktest
  ? `Treat this as a true historical simulation from ${config.startDate} to ${config.endDate}. You only know what your tools show you on the current simulation date.`
  : `Operate continuously in ${config.mode} mode. Monitor market hours, existing positions, and new signals over time.`}

${isBacktest
  ? `Backtest loop:
1. Call \`get_sim_state()\` at the start of each trading day.
2. Review portfolio state with \`get_portfolio()\` and \`get_recent_orders()\`.
3. Gather fresh signals with the thesis-relevant MCP tools. Prefer a small number of targeted searches over many broad, repetitive ones.
4. Make your decision with \`buy_stock()\`, \`sell_stock()\`, \`short_stock()\`, or \`do_nothing()\`.
5. Call \`log_decision()\` with your action, symbol/amount if traded, and a concise markdown reasoning. Keep it brief: 2-4 bullets or a short paragraph.
6. Call \`advance_to_next_trading_day()\` exactly once when the day is finished.
7. When \`advance_to_next_trading_day()\` returns \`{"done": true}\`, write a short final performance summary and exit.`
  : `Pre-market analysis protocol (one-shot run — exit after logging your decision):
1. Call \`get_current_time()\` to note the current ET time.
2. Call \`get_portfolio()\` and \`get_recent_orders()\` to review current positions.
3. Gather fresh signals using the thesis-relevant MCP tools. Prefer 2–4 targeted searches over many broad ones.
4. Make your decision: buy, sell, short, or hold. Use \`buy_stock()\`, \`sell_stock()\`, \`short_stock()\`, or \`do_nothing()\` to act.
5. Call \`log_decision()\` with your action, symbol/amount if traded, and concise markdown reasoning (2–4 bullets).
6. **Exit immediately after logging.** Do not loop or continue monitoring — this harness is scheduled daily and will run again tomorrow.`}

## Available Tools
${toolLines.join("\n")}
`
}

function buildToolDocs(bot: ScheduledBotConfig, config: HarnessRunConfig): string[] {
  const lines = config.mode === "backtest"
    ? [
        "- `get_sim_state()` — current simulation date and day progress",
        "- `advance_to_next_trading_day()` — finish the day and move to the next trading day",
        "- `get_trading_calendar()` — full trading calendar for this run",
        "- `log_decision(text, action, symbol?, amount?)` — record decision to DB. `text` must be exactly 4 bullets: (1) action/symbol/amount/% of portfolio, (2) sizing rationale, (3) specific signals with numbers, (4) risks and next catalyst",
      ]
    : [
        "- `get_current_time()` — current wall-clock time in ET plus market-open status",
        "- `log_decision(text, action, symbol?, amount?)` — record decision to DB. `text` must be exactly 4 bullets: (1) action/symbol/amount/% of portfolio, (2) sizing rationale, (3) specific signals with numbers, (4) risks and next catalyst",
      ]

  if (bot.mcps.some((mcp) => mcp.name === "trade")) {
    lines.push(
      "- `get_portfolio()` — current cash, positions, and mark-to-market summary",
      "- `get_recent_orders()` — recent fills or simulated orders",
      "- `get_market_snapshot()` — SPY regime context before new longs",
      "- `buy_stock(symbol, dollar_amount, reason)` — open or add to a long position",
      "- `sell_stock(symbol, dollar_amount?, reason)` — reduce or exit a long position",
      "- `short_stock(symbol, dollar_amount, reason)` — open or add to a short position",
      "- `do_nothing(reason)` — explicitly hold when no trade is warranted",
    )
  }

  if (bot.mcps.some((mcp) => mcp.name === "web-search")) {
    lines.push("- `web_search(query, type, lookback_days)` — Alpaca financial news or DuckDuckGo general search")
  }

  if (bot.mcps.some((mcp) => mcp.name === "trump-posts")) {
    lines.push("- `get_trump_posts(lookback_days)` — Truth Social posts capped to the current sim date")
  }

  return lines
}

function buildInitialPrompt(bot: ScheduledBotConfig, config: HarnessRunConfig, isResuming: boolean): string {
  if (isResuming) {
    return config.mode === "backtest"
      ? `Resume the interrupted ${bot.name} backtest. Call get_sim_state() first, then continue from the current trading day until the backtest is complete.`
      : `Resume the interrupted ${bot.name} ${config.mode} trading session. Check get_current_time(), review the portfolio, and continue naturally.`
  }

  if (config.mode === "backtest") {
    return `Run the full ${bot.name} backtest from ${config.startDate} to ${config.endDate}. Starting cash is $${STARTING_CASH.toLocaleString()}. Begin with get_sim_state(), log every day's decision, and exit after advance_to_next_trading_day() returns {"done": true}.`
  }

  return `You are the daily pre-market analyst for ${bot.name} (${config.mode} mode). This is a one-shot run — you will make exactly one trading decision and then exit. Start with get_current_time(), inspect the portfolio with get_portfolio() and get_recent_orders(), gather 2–4 targeted signals, execute your trade or do_nothing(), then call log_decision() and exit. Do not loop.`
}

function finalizeBacktestRun(runId: number) {
  const db = getDb()
  const snapshots = db
    .query<HarnessPnlRow, [number]>(
      `SELECT portfolio_value, spy_value, sim_date
       FROM pnl_snapshots
       WHERE run_id = ?
       ORDER BY sim_date ASC`,
    )
    .all(runId)

  if (snapshots.length === 0) {
    throw new Error(`Harness backtest ${runId} completed without any PnL snapshots`)
  }

  const finalSnapshot = snapshots[snapshots.length - 1]
  const totalReturn = (finalSnapshot.portfolio_value - STARTING_CASH) / STARTING_CASH
  const finalSpyValue = finalSnapshot.spy_value ?? STARTING_CASH
  const spyReturn = (finalSpyValue - STARTING_CASH) / STARTING_CASH
  const maxDrawdown = calculateMaxDrawdown([STARTING_CASH, ...snapshots.map((snapshot) => snapshot.portfolio_value)])
  const beatsSpy = totalReturn > spyReturn ? 1 : 0

  db.run(
    `UPDATE runs
     SET status = 'completed',
         completed_at = ?,
         total_return = ?,
         spy_return = ?,
         max_drawdown = ?,
         beats_spy = ?
     WHERE id = ?`,
    [new Date().toISOString(), totalReturn, spyReturn, maxDrawdown, beatsSpy, runId],
  )

  return { totalReturn, spyReturn, maxDrawdown }
}

function resolveMcpArgs(projectRoot: string, args: string[]): string[] {
  return args.map((arg) => {
    if (!arg.startsWith("-") && (arg.includes("/") || arg.endsWith(".ts") || arg.endsWith(".js") || arg.endsWith(".json"))) {
      return resolve(projectRoot, arg)
    }
    return arg
  })
}

function makeLogFilePath(
  dataDir: string,
  runId: number,
  bot: ScheduledBotConfig,
  config: HarnessRunConfig,
): string {
  const slug = [
    config.harness,
    bot.id,
    config.mode,
    config.startDate,
    config.endDate ? `to-${config.endDate}` : undefined,
    `run${runId}`,
  ]
    .filter(Boolean)
    .join("-")
    .replace(/[^\w.-]+/g, "-")

  return join(dataDir, "logs", `${slug}.md`)
}

function appendRunLog(logFile: string, text: string) {
  appendFileSync(logFile, `\n---\n_${new Date().toISOString()}_\n\n${text}\n`, "utf8")
}

function cleanupTerminalRunFiles(workingDir: string, simClockFile: string, backtestStateFile: string | null) {
  rmSync(workingDir, { recursive: true, force: true })
  rmSync(simClockFile, { force: true })
  if (backtestStateFile) rmSync(backtestStateFile, { force: true })
}
