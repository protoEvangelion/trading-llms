import type { ChatCompletionMessageParam } from "openai/resources"
import { callLLM } from "./llm.js"
import { bootMcpClients, dispatchToolCall, shutdownMcpClients } from "./mcp-client.js"
import {
  logDecision,
  getPositionReasons,
  upsertPositionReason,
  closePositionReason,
  updatePositionReasonAmount,
} from "./db.js"
import { getAlpacaConfig, getAccount, getPositions } from "./alpaca.js"
import type { McpConfig } from "./mcp-client.js"

export interface BotConfig {
  id: string
  name: string
  description?: string
  model: string
  system_prompt: string
  /** Env var name holding this bot's Alpaca API key */
  alpacaKeyEnv: string
  /** Env var name holding this bot's Alpaca API secret */
  alpacaSecretEnv: string
  /** Env var name holding this bot's Alpaca endpoint URL */
  alpacaEndpointEnv: string
  mcps: McpConfig[]
}

/**
 * Passed to runBot when executing inside a backtest simulation.
 * Controls the fake clock and routes Alpaca tool calls to the sim MCP.
 */
export interface BacktestContext {
  /** ISO datetime string representing "now" for the agent, e.g. "2025-04-07T09:45:00" */
  simDateTime: string
  /** Path to the JSON state file shared with the backtest-trade MCP */
  stateFilePath: string
  /** backtest_runs.id — used to log decisions to backtest_decisions table */
  backtestRunId: number
}

const TERMINAL_TOOLS = new Set(["buy_stock", "sell_stock", "short_stock", "do_nothing"])
const MAX_ITERATIONS = 10

/**
 * Formats active position reasons as a context block injected into the LLM's
 * initial message. This lets the LLM evaluate whether prior reasoning still holds.
 */
function formatPositionReasonsContext(botId: string): string {
  const reasons = getPositionReasons(botId)
  if (reasons.length === 0) return ""

  const lines = reasons.map((r) => {
    const amount = r.entry_amount ? ` ($${r.entry_amount.toLocaleString()} entered)` : ""
    const date = r.entered_at.slice(0, 10)
    return (
      `▸ ${r.symbol}${amount} — entered ${date}\n` +
      `  Original reason: "${r.reason}"\n` +
      `  → Is this reason still valid? Has the signal changed? Consider: hold / add / scale out / exit.`
    )
  })

  return (
    `\n\nACTIVE POSITION REASONS (your reasoning when you entered these positions):\n` +
    `${"─".repeat(60)}\n` +
    lines.join("\n\n") +
    `\n${"─".repeat(60)}`
  )
}

/**
 * Convert "YYYY-MM-DDTHH:MM:SS" expressed in US Eastern Time to a UTC ISO string.
 * Simplified rule: months 4–10 = EDT (UTC-4), otherwise EST (UTC-5).
 */
function etToUTC(simDateTime: string): string {
  const month = parseInt(simDateTime.slice(5, 7), 10)
  const offsetHours = month >= 4 && month <= 10 ? 4 : 5
  // Parse as UTC then shift — avoids any system-local-time ambiguity
  const d = new Date(simDateTime + "Z")
  d.setUTCHours(d.getUTCHours() + offsetHours)
  return d.toISOString()
}

/**
 * Build the MCP config list for this run, applying:
 * 1. Alpaca credential injection (live/paper)
 * 2. Backtest substitutions: replace trade with backtest-trade,
 *    inject SIM_DATE + SIM_DATETIME_UTC into all MCPs that support it.
 */
function buildMcpConfigs(bot: BotConfig, backtest?: BacktestContext): McpConfig[] {
  return bot.mcps.map((mcp) => {
    const simEnv: Record<string, string> = backtest
      ? {
          SIM_DATE: backtest.simDateTime.slice(0, 10),
          SIM_DATETIME_UTC: etToUTC(backtest.simDateTime),
        }
      : {}

    if (mcp.name === "trade") {
      if (backtest) {
        // Swap in the simulation MCP instead of hitting real Alpaca
        return {
          name: "backtest-trade",
          command: "bun",
          args: ["run", "runner/src/mcps/backtest-trade.ts"],
          env: {
            BACKTEST_STATE_FILE: backtest.stateFilePath,
            SIM_DATE: backtest.simDateTime.slice(0, 10),
            ALPACA_KEY: process.env[bot.alpacaKeyEnv] ?? "",
            ALPACA_SECRET: process.env[bot.alpacaSecretEnv] ?? "",
          },
        }
      }
      // Live/paper: inject real credentials
      return {
        ...mcp,
        env: {
          ...mcp.env,
          ALPACA_KEY: process.env[bot.alpacaKeyEnv] ?? "",
          ALPACA_SECRET: process.env[bot.alpacaSecretEnv] ?? "",
          ALPACA_ENDPOINT: process.env[bot.alpacaEndpointEnv] ?? "",
        },
      }
    }

    // All other MCPs: inject SIM_DATE if in backtest mode
    if (backtest && Object.keys(simEnv).length > 0) {
      return { ...mcp, env: { ...mcp.env, ...simEnv } }
    }

    return mcp
  })
}

export async function runBot(bot: BotConfig, backtest?: BacktestContext): Promise<void> {
  const startTime = Date.now()
  const modeLabel = backtest ? `[backtest:${backtest.simDateTime.slice(0, 10)}]` : "[live]"
  console.log(`\n[${bot.id}]${modeLabel} ▶ Starting run at ${new Date().toISOString()}`)

  const enrichedMcps = buildMcpConfigs(bot, backtest)
  const mcpClients = await bootMcpClients(enrichedMcps)

  if (mcpClients.toolDefinitions.length === 0) {
    console.error(`[${bot.id}] No MCP tools available — aborting run`)
    return
  }

  // Build position reasons context block (empty string if no open positions)
  const reasonsContext = formatPositionReasonsContext(bot.id)

  // "Now" is either the sim datetime (backtest) or real wall time (live)
  const nowLabel = backtest
    ? `${backtest.simDateTime} ET (SIMULATION)`
    : new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET"

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: bot.system_prompt },
    {
      role: "user",
      content:
        `Current date and time: ${nowLabel}` +
        (backtest
          ? `\n\nIMPORTANT: You are in a historical simulation. Today is ${backtest.simDateTime.slice(0, 10)}. ` +
            `Make decisions ONLY based on signals observable through your tools. ` +
            `Do NOT trade on knowledge from your training data about future outcomes — ` +
            `you cannot know what will happen next. Treat this like a real trading day.`
          : "") +
        reasonsContext +
        `\n\nReview the available information and make your trading decision. ` +
        `Start by checking the portfolio, then gather relevant market signals.`,
    },
  ]

  const toolCallLog: Array<{ tool: string; args: unknown; result: string }> = []
  let finalAction = "unknown"
  let finalReasoning = ""
  let tradedSymbol: string | undefined
  let tradedAmount: number | undefined
  let isSellAll = false
  let iterations = 0
  let totalPromptTokens = 0
  let totalCompletionTokens = 0

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++
      console.log(`[${bot.id}] Iteration ${iterations}/${MAX_ITERATIONS}`)

      const { choice, usage } = await callLLM({
        model: bot.model,
        messages,
        tools: mcpClients.toolDefinitions,
      })

      if (usage) {
        totalPromptTokens += usage.prompt_tokens ?? 0
        totalCompletionTokens += usage.completion_tokens ?? 0
        console.log(`[${bot.id}] tokens: +${usage.prompt_tokens}p +${usage.completion_tokens}c (running: ${totalPromptTokens}p ${totalCompletionTokens}c)`)
      }

      const message = choice.message

      if (message.content) {
        finalReasoning += (finalReasoning ? "\n\n" : "") + message.content
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        // Model returned reasoning text but called no tools.
        // If we haven't hit a terminal action yet, nudge it once to execute.
        if (finalAction === "unknown" && iterations < MAX_ITERATIONS) {
          console.log(`[${bot.id}] LLM reasoned without calling tools — nudging to execute`)
          messages.push({ role: "assistant", content: message.content ?? null })
          messages.push({ role: "user", content: "You described your plan but called no tools. Execute your trades now — call buy_stock, sell_stock, or do_nothing." })
          continue
        }
        finalAction = "no_action"
        console.log(`[${bot.id}] LLM finished without explicit tool call`)
        break
      }

      messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls })

      let hitTerminal = false
      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name
        const toolArgs = JSON.parse(toolCall.function.arguments ?? "{}") as Record<string, unknown>

        console.log(`[${bot.id}] → calling tool: ${toolName}`)

        const result = await dispatchToolCall(mcpClients, toolName, toolArgs)
        toolCallLog.push({ tool: toolName, args: toolArgs, result })
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: result })

        if (TERMINAL_TOOLS.has(toolName)) {
          hitTerminal = true
          // Trades take priority — do_nothing should never overwrite a buy/sell
          if (toolName !== "do_nothing" || finalAction === "unknown" || finalAction === "no_action") {
            finalAction = toolName
          }

          if (toolName === "do_nothing") {
            finalReasoning = (toolArgs.reason as string | undefined) ?? finalReasoning
          } else if (toolName === "buy_stock") {
            tradedSymbol = toolArgs.symbol as string | undefined
            tradedAmount = toolArgs.dollar_amount as number | undefined
            finalReasoning = (toolArgs.reason as string | undefined) ?? finalReasoning
            if (tradedSymbol && finalReasoning) {
              upsertPositionReason({
                botId: bot.id,
                symbol: tradedSymbol,
                reason: finalReasoning,
                entryAmount: tradedAmount,
              })
            }
          } else if (toolName === "short_stock") {
            tradedSymbol = toolArgs.symbol as string | undefined
            tradedAmount = toolArgs.dollar_amount as number | undefined
            finalReasoning = (toolArgs.reason as string | undefined) ?? finalReasoning
          } else if (toolName === "sell_stock") {
            tradedSymbol = toolArgs.symbol as string | undefined
            tradedAmount = toolArgs.dollar_amount as number | undefined
            finalReasoning = (toolArgs.reason as string | undefined) ?? finalReasoning
            isSellAll = tradedAmount === undefined

            if (tradedSymbol) {
              if (isSellAll) {
                closePositionReason(bot.id, tradedSymbol)
              } else if (tradedAmount !== undefined) {
                // Partial sell: update entry_amount in position_reasons
                const reasons = getPositionReasons(bot.id)
                const existing = reasons.find((r) => r.symbol === tradedSymbol!.toUpperCase())
                if (existing && existing.entry_amount != null) {
                  const newAmount = Math.max(0, existing.entry_amount - tradedAmount)
                  updatePositionReasonAmount(bot.id, tradedSymbol, newAmount)
                }
              }
            }
          }
        }
      }

      if (hitTerminal) {
        console.log(`[${bot.id}] Terminal action reached: ${finalAction}`)
        break
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      console.warn(`[${bot.id}] Hit max iterations without terminal action`)
      finalAction = "max_iterations"
    }

    const totalTokens = totalPromptTokens + totalCompletionTokens
    console.log(`[${bot.id}] 📊 Token usage: ${totalPromptTokens.toLocaleString()} prompt + ${totalCompletionTokens.toLocaleString()} completion = ${totalTokens.toLocaleString()} total (${iterations} LLM calls)`)

    // Log decision (unified table; backtest rows carry backtestRunId + simDate)
    logDecision({
      botId: bot.id,
      reasoning: finalReasoning || "No reasoning captured",
      action: finalAction,
      symbol: tradedSymbol,
      amount: tradedAmount,
      toolCalls: toolCallLog,
      backtestRunId: backtest?.backtestRunId,
      simDate: backtest?.simDateTime.slice(0, 10),
    })

    if (!backtest) {

      // Live/paper: snapshot P&L via Alpaca API
      try {
        const alpacaConfig = getAlpacaConfig(
          bot.alpacaKeyEnv,
          bot.alpacaSecretEnv,
          bot.alpacaEndpointEnv,
        )
        const [account, positions] = await Promise.all([
          getAccount(alpacaConfig),
          getPositions(alpacaConfig),
        ])

        // P&L snapshot is now a dedicated EOD cron, not per-run — but we still
        // log it here for backward compat with the existing webapp queries.
        const { logPnlSnapshot } = await import("./db.js")
        logPnlSnapshot({
          botId: bot.id,
          mode: "live",
          portfolioValue: parseFloat(account.portfolio_value),
          cash: parseFloat(account.cash),
          positions,
        })

        console.log(
          `[${bot.id}] ✅ Run complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s | ` +
            `action: ${finalAction} | portfolio: $${parseFloat(account.portfolio_value).toLocaleString()}`,
        )
      } catch (err) {
        console.error(`[${bot.id}] Failed to snapshot P&L:`, err)
      }
    }

    if (backtest) {
      console.log(
        `[${bot.id}] ✅ Backtest tick complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s | action: ${finalAction}`,
      )
    }
  } catch (err) {
    console.error(`[${bot.id}] Run failed:`, err)

    logDecision({
      botId: bot.id,
      reasoning: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
      action: "error",
      toolCalls: toolCallLog,
      backtestRunId: backtest?.backtestRunId,
      simDate: backtest?.simDateTime.slice(0, 10),
    })
  } finally {
    await shutdownMcpClients(mcpClients)
  }
}
