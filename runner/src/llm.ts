import { GoogleGenAI, type Content, type Part } from "@google/genai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources"

// OpenRouter — kept for reference, not currently active
// const _openRouterClient = new OpenAI({
//   apiKey: process.env.OPENROUTER_API_KEY,
//   baseURL: "https://openrouter.ai/api/v1",
//   defaultHeaders: { "HTTP-Referer": "https://github.com/trading-bots", "X-Title": "Trading Bots" },
// })

// Google Gemini — native SDK (uses X-goog-api-key, not Bearer)
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GEMINI_API_KEY })

const MAX_RETRIES = 5

const BREVITY_DIRECTIVE = `
RESPONSE STYLE: Be extremely terse. No preamble, no summaries, no explanations of what you're doing. Think in bullet points. When reasoning, use fragments. Every word costs money.`

/**
 * Maps assistant message objects → their raw Google Content.
 * Thinking-model responses attach thoughtSignature to functionCall parts.
 * These signatures must be round-tripped verbatim in multi-turn conversations —
 * they are lost when we convert to OpenAI format and back. By preserving the
 * original Content here and looking it up in toGoogleContents, we avoid the
 * INVALID_ARGUMENT "missing thought_signature" error on turn 2+.
 *
 * Keyed by the exact object reference that callLLM returns as choice.message.
 * bot-runner must push that same object (not a spread/copy) for the lookup to work.
 */
const rawGoogleContent = new WeakMap<object, Content>()

/**
 * Convert OpenAI-format messages to Google Content array.
 * Extracts system prompt separately (Google takes it as systemInstruction).
 * Consecutive tool-result messages are merged into one user turn.
 * Assistant messages with a stored rawGoogleContent are passed through verbatim.
 */
function toGoogleContents(messages: ChatCompletionMessageParam[]): {
  systemInstruction: string | undefined
  contents: Content[]
} {
  // Build tool_call_id → function name map so we can name functionResponses correctly
  const toolCallNames: Record<string, string> = {}
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) toolCallNames[tc.id] = tc.function.name
    }
  }

  let systemInstruction: string | undefined
  const contents: Content[] = []

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = (typeof msg.content === "string" ? msg.content : "") + BREVITY_DIRECTIVE
      continue
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
      contents.push({ role: "user", parts: [{ text }] })
      continue
    }

    if (msg.role === "assistant") {
      // Use raw Google Content if available — preserves thoughtSignature on functionCall parts
      const raw = rawGoogleContent.get(msg)
      if (raw) {
        contents.push(raw)
        continue
      }
      // Fallback: reconstruct (for synthetic assistant messages, e.g. nudge turns)
      const parts: Part[] = []
      if (msg.content) parts.push({ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) })
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
            },
          })
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts })
      continue
    }

    if (msg.role === "tool") {
      const funcName = toolCallNames[msg.tool_call_id] ?? msg.tool_call_id
      const output = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)

      // Merge consecutive tool responses into the same user turn
      const last = contents[contents.length - 1]
      const responsePart: Part = { functionResponse: { name: funcName, response: { output } } }
      if (last?.role === "user" && last.parts?.some((p) => "functionResponse" in p)) {
        last.parts.push(responsePart)
      } else {
        contents.push({ role: "user", parts: [responsePart] })
      }
    }
  }

  return { systemInstruction, contents }
}

/**
 * Convert OpenAI ChatCompletionTool definitions to Google FunctionDeclarations.
 */
function toGoogleTools(tools: ChatCompletionTool[]) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters as Record<string, unknown>,
  }))
}

export async function callLLM(params: {
  model: string
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionTool[]
}) {
  // Google model IDs don't use the "google/" vendor prefix used by OpenRouter
  const model = params.model.replace(/^google\//, "")
  const { systemInstruction, contents } = toGoogleContents(params.messages)
  const functionDeclarations = toGoogleTools(params.tools)

  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
          temperature: 0.3,
          maxOutputTokens: 1024,
          // Ask thinking models to skip thinking — reduces token usage and avoids
          // thoughtSignature round-trip issues. Falls back to WeakMap approach if
          // the model ignores this (thinkingBudget:0 not always honored).
          thinkingConfig: { thinkingBudget: 0 },
        },
      })

      // Convert Google response → OpenAI-compatible choice shape
      const candidate = response.candidates?.[0]
      const parts = candidate?.content?.parts ?? []

      // Exclude thought parts (thought: true) from user-visible text content
      const textParts = parts.filter((p) => p.text != null && !p.thought)
      const fnParts = parts.filter((p) => p.functionCall != null)

      const content = textParts.map((p) => p.text).join("") || null

      const tool_calls =
        fnParts.length > 0
          ? fnParts.map((p, i) => ({
              id: `call_${Date.now()}_${i}`,
              type: "function" as const,
              function: {
                name: p.functionCall!.name ?? "",
                arguments: JSON.stringify(p.functionCall!.args ?? {}),
              },
            }))
          : undefined

      // Build the message object ONCE and register it in rawGoogleContent.
      // bot-runner must push this exact object (not a spread) so the WeakMap lookup works.
      const message: ChatCompletionMessageParam = { role: "assistant" as const, content, tool_calls }
      if (candidate?.content) rawGoogleContent.set(message, candidate.content)

      const choice = {
        index: 0,
        finish_reason: candidate?.finishReason ?? "stop",
        message,
      }

      const meta = response.usageMetadata
      const usage = meta
        ? {
            prompt_tokens: meta.promptTokenCount ?? 0,
            completion_tokens: meta.candidatesTokenCount ?? 0,
            total_tokens: meta.totalTokenCount ?? 0,
          }
        : null

      return { choice, usage }
    } catch (err: unknown) {
      lastErr = err
      const status = (err as { status?: number; code?: number }).status ?? (err as { code?: number }).code
      if (status === 429) {
        const waitMs = Math.min(15_000 * 2 ** (attempt - 1), 120_000)
        console.warn(`[llm] Rate limited (attempt ${attempt}/${MAX_RETRIES}) — waiting ${(waitMs / 1000).toFixed(0)}s...`)
        await Bun.sleep(waitMs)
        continue
      }
      console.error(`[llm] Error (attempt ${attempt}/${MAX_RETRIES}):`, (err as Error).message ?? err)
      throw err
    }
  }
  throw lastErr
}

export type { ChatCompletionMessageParam, ChatCompletionTool }
