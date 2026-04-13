import type { ChatCompletionMessageParam } from "openai/resources"
import { callLLM } from "./llm.js"
import { bootMcpClients, dispatchToolCall, shutdownMcpClients } from "./mcp-client.js"
import {
  logDecision,
  logPnlSnapshot,
  getPositionTheses,
  upsertPositionThesis,
  deletePositionThesis,
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

const TERMINAL_TOOLS = new Set(["buy_stock", "sell_stock", "do_nothing"])
const MAX_ITERATIONS = 10

/**
 * Formats active position theses as a context block injected into the LLM's
 * initial message. This lets the LLM evaluate whether prior thesis still holds.
 */
function formatPositionThesesContext(botId: string): string {
  const theses = getPositionTheses(botId)
  if (theses.length === 0) return ""

  const lines = theses.map((t) => {
    const amount = t.entry_amount ? ` ($${t.entry_amount.toLocaleString()} entered)` : ""
    const date = t.entered_at.slice(0, 10)
    return (
      `▸ ${t.symbol}${amount} — entered ${date}\n` +
      `  Original thesis: "${t.thesis}"\n` +
      `  → Is this thesis still valid? Has the signal changed? Consider: hold / add / scale out / exit.`
    )
  })

  return (
    `\n\nACTIVE POSITION THESES (your reasoning when you entered these positions):\n` +
    `${"─".repeat(60)}\n` +
    lines.join("\n\n") +
    `\n${"─".repeat(60)}`
  )
}

export async function runBot(bot: BotConfig): Promise<void> {
  const startTime = Date.now()
  console.log(`\n[${bot.id}] ▶ Starting run at ${new Date().toISOString()}`)

  // Inject bot-specific Alpaca credentials as generic env vars so the
  // alpaca-trade MCP child process can read them without knowing the bot name.
  const enrichedMcps: McpConfig[] = bot.mcps.map((mcp) =>
    mcp.name === "alpaca-trade"
      ? {
          ...mcp,
          env: {
            ...mcp.env,
            ALPACA_KEY: process.env[bot.alpacaKeyEnv] ?? "",
            ALPACA_SECRET: process.env[bot.alpacaSecretEnv] ?? "",
            ALPACA_ENDPOINT: process.env[bot.alpacaEndpointEnv] ?? "",
          },
        }
      : mcp,
  )

  const mcpClients = await bootMcpClients(enrichedMcps)

  if (mcpClients.toolDefinitions.length === 0) {
    console.error(`[${bot.id}] No MCP tools available — aborting run`)
    return
  }

  // Build thesis context block (empty string if no open positions)
  const thesisContext = formatPositionThesesContext(bot.id)

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: bot.system_prompt },
    {
      role: "user",
      content:
        `Current date and time: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET` +
        thesisContext +
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

  try {
    // Agentic loop
    while (iterations < MAX_ITERATIONS) {
      iterations++
      console.log(`[${bot.id}] Iteration ${iterations}/${MAX_ITERATIONS}`)

      const choice = await callLLM({
        model: bot.model,
        messages,
        tools: mcpClients.toolDefinitions,
      })

      const message = choice.message

      // Capture any text content as reasoning
      if (message.content) {
        finalReasoning += (finalReasoning ? "\n\n" : "") + message.content
      }

      // No tool calls — LLM is done
      if (!message.tool_calls || message.tool_calls.length === 0) {
        finalAction = "no_action"
        console.log(`[${bot.id}] LLM finished without explicit tool call`)
        break
      }

      // Add assistant message to context
      messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls })

      // Process tool calls
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
          finalAction = toolName

          if (toolName === "do_nothing") {
            finalReasoning = (toolArgs.reason as string | undefined) ?? finalReasoning
          } else if (toolName === "buy_stock") {
            tradedSymbol = toolArgs.symbol as string | undefined
            tradedAmount = toolArgs.dollar_amount as number | undefined
            finalReasoning = (toolArgs.reason as string | undefined) ?? finalReasoning
            // Track position thesis so next run knows why we hold this
            if (tradedSymbol && finalReasoning) {
              upsertPositionThesis({
                botId: bot.id,
                symbol: tradedSymbol,
                thesis: finalReasoning,
                entryAmount: tradedAmount,
              })
            }
          } else if (toolName === "sell_stock") {
            tradedSymbol = toolArgs.symbol as string | undefined
            tradedAmount = toolArgs.dollar_amount as number | undefined
            finalReasoning = (toolArgs.reason as string | undefined) ?? finalReasoning
            isSellAll = tradedAmount === undefined
            // Remove thesis when fully closing a position
            if (tradedSymbol && isSellAll) {
              deletePositionThesis(bot.id, tradedSymbol)
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

    logDecision({
      botId: bot.id,
      reasoning: finalReasoning || "No reasoning captured",
      action: finalAction,
      symbol: tradedSymbol,
      amount: tradedAmount,
      toolCalls: toolCallLog,
    })

    // Snapshot P&L using this bot's credentials
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

      logPnlSnapshot({
        botId: bot.id,
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
  } catch (err) {
    console.error(`[${bot.id}] Run failed:`, err)
    logDecision({
      botId: bot.id,
      reasoning: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
      action: "error",
      toolCalls: toolCallLog,
    })
  } finally {
    await shutdownMcpClients(mcpClients)
  }
}
