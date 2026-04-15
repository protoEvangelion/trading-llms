/**
 * Backtest Runner
 *
 * Orchestrates a full backtest for a given bot over a date range.
 * For each trading day, runs the bot's agent with a fake clock (SIM_DATE)
 * so all tool calls are anchored to that historical point in time.
 *
 * Respects the bot's cron schedule — if a bot runs 5x/day in production,
 * it runs 5x per simulated trading day.
 *
 * Portfolio state is shared between the bot-runner and the backtest-trade
 * MCP via a JSON state file on disk.
 */

import type { ScheduledBotConfig } from "./bots.js"
import { runBot, type BacktestContext } from "./bot-runner.js"
import {
  createBacktestRun,
  completeBacktestRun,
  failBacktestRun,
  logPnlSnapshot,
  clearPositionReasons,
  getDb,
} from "./db.js"
import {
  type SimState,
  writeSimState,
  readSimState,
  deleteSimStateFile,
  makeStateFilePath,
  getTradingDays,
  getOpenPrice,
  getClosePrice,
  calculatePortfolioValue,
  getSimDateTimes,
  calculateMaxDrawdown,
} from "./simulation.js"

const STARTING_CASH = 100_000

export async function runBacktest(
  bot: ScheduledBotConfig,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
): Promise<void> {
  // Always run backtests against dev.db
  process.env.TRADING_ENV = "dev"

  const alpacaKey = process.env[bot.alpacaKeyEnv]
  const alpacaSecret = process.env[bot.alpacaSecretEnv]

  if (!alpacaKey || !alpacaSecret) {
    throw new Error(
      `Missing Alpaca credentials for ${bot.id}: ` +
      `${bot.alpacaKeyEnv} / ${bot.alpacaSecretEnv} not set`
    )
  }

  // Ensure DB is initialized
  const db = getDb()

  console.log(`\n[backtest:${bot.id}] ▶ Starting backtest ${startDate} → ${endDate}`)
  console.log(`[backtest:${bot.id}] Fetching trading calendar...`)

  // Get trading days
  let tradingDays: string[]
  try {
    tradingDays = await getTradingDays(startDate, endDate, alpacaKey, alpacaSecret)
  } catch (err) {
    throw new Error(`Failed to fetch trading calendar: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (tradingDays.length === 0) {
    throw new Error(`No trading days found between ${startDate} and ${endDate}`)
  }

  console.log(`[backtest:${bot.id}] ${tradingDays.length} trading days found`)

  // Get SPY starting price for benchmark tracking
  let spyStartPrice: number
  try {
    spyStartPrice = await getOpenPrice("SPY", startDate, alpacaKey, alpacaSecret)
    console.log(`[backtest:${bot.id}] SPY start price: $${spyStartPrice.toFixed(2)}`)
  } catch (err) {
    throw new Error(`Failed to fetch SPY start price: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Create backtest run record
  const runId = createBacktestRun({ botId: bot.id, simStart: startDate, simEnd: endDate })
  console.log(`[backtest:${bot.id}] Run ID: ${runId}`)

  // Create state file
  const dataDir = process.env.TRADING_BOTS_DATA_DIR ?? new URL("../../data", import.meta.url).pathname
  const stateFilePath = makeStateFilePath(dataDir, runId)

  const initialState: SimState = {
    runId,
    botId: bot.id,
    simDate: startDate,
    cash: STARTING_CASH,
    positions: {},
    orders: [],
  }
  writeSimState(stateFilePath, initialState)

  // Clear any stale position_reasons from a prior run before starting fresh
  clearPositionReasons(bot.id)

  const pnlValues: number[] = [STARTING_CASH]

  try {
    for (let i = 0; i < tradingDays.length; i++) {
      const day = tradingDays[i]

      console.log(`\n[backtest:${bot.id}] 📅 ${day} (day ${i + 1}/${tradingDays.length})`)

      // Update simDate in state file so the MCP sees the correct date
      const dayState = readSimState(stateFilePath)
      dayState.simDate = day
      writeSimState(stateFilePath, dayState)

      // Get the scheduled simulation datetimes for this day
      const simDateTimes = getSimDateTimes(day, bot.cron)
      console.log(`[backtest:${bot.id}] Running ${simDateTimes.length} agent tick(s): ${simDateTimes.map((d) => d.slice(11, 16)).join(", ")}`)

      // Run agent for each cron tick on this day
      for (const simDateTime of simDateTimes) {
        const backtestCtx: BacktestContext = {
          simDateTime,
          stateFilePath,
          backtestRunId: runId,
        }

        try {
          await runBot(bot, backtestCtx)
        } catch (err) {
          console.error(`[backtest:${bot.id}] Agent error on ${simDateTime}:`, err)
          // Continue to next tick — don't abort the whole backtest on one error
        }
      }

      // EOD snapshot: value portfolio at day's close
      const endOfDayState = readSimState(stateFilePath)
      const portfolioValue = await calculatePortfolioValue(endOfDayState, day, alpacaKey, alpacaSecret)
      pnlValues.push(portfolioValue)

      // SPY value: proportional to starting SPY price (what $100k in SPY would be worth)
      let spyValue = STARTING_CASH
      try {
        const spyClose = await getClosePrice("SPY", day, alpacaKey, alpacaSecret)
        spyValue = (spyClose / spyStartPrice) * STARTING_CASH
      } catch {
        spyValue = pnlValues[pnlValues.length - 2] ?? STARTING_CASH  // carry forward on error
      }

      logPnlSnapshot({
        backtestRunId: runId,
        botId: bot.id,
        simDate: day,
        portfolioValue,
        cash: endOfDayState.cash,
        spyValue,
        positions: endOfDayState.positions,
      })

      const returnPct = ((portfolioValue - STARTING_CASH) / STARTING_CASH * 100).toFixed(2)
      const spyReturnPct = ((spyValue - STARTING_CASH) / STARTING_CASH * 100).toFixed(2)
      console.log(
        `[backtest:${bot.id}] EOD | Portfolio: $${portfolioValue.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${returnPct}%) | SPY equiv: $${spyValue.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${spyReturnPct}%)`
      )
    }

    // Calculate final metrics
    const finalState = readSimState(stateFilePath)
    const finalValue = await calculatePortfolioValue(finalState, tradingDays[tradingDays.length - 1], alpacaKey, alpacaSecret)

    const totalReturn = (finalValue - STARTING_CASH) / STARTING_CASH

    // SPY return over same period
    let spyReturn = 0
    try {
      const spyEnd = await getClosePrice("SPY", tradingDays[tradingDays.length - 1], alpacaKey, alpacaSecret)
      spyReturn = (spyEnd / spyStartPrice) - 1
    } catch {}

    const maxDrawdown = calculateMaxDrawdown(pnlValues)

    completeBacktestRun({ runId, totalReturn, spyReturn, maxDrawdown })

    const beatsSpy = totalReturn > spyReturn

    console.log(`\n[backtest:${bot.id}] ✅ Backtest complete!`)
    console.log(`  Period:         ${startDate} → ${endDate} (${tradingDays.length} trading days)`)
    console.log(`  Total Return:   ${(totalReturn * 100).toFixed(2)}%`)
    console.log(`  SPY Return:     ${(spyReturn * 100).toFixed(2)}%`)
    console.log(`  Beats SPY:      ${beatsSpy ? "✅ YES" : "❌ NO"}`)
    console.log(`  Max Drawdown:   ${(maxDrawdown * 100).toFixed(2)}%`)
    console.log(`  Final Value:    $${finalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`)
    console.log(`  Orders placed:  ${finalState.orders.length}`)

  } catch (err) {
    failBacktestRun(runId, err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    deleteSimStateFile(stateFilePath)
  }
}
