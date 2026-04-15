import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources"

// OpenRouter is OpenAI-compatible
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/trading-bots",
    "X-Title": "Trading Bots",
  },
})

const MAX_RETRIES = 3

const BREVITY_DIRECTIVE = `
RESPONSE STYLE: Be extremely terse. No preamble, no summaries, no explanations of what you're doing. Think in bullet points. When reasoning, use fragments. Every word costs money.`

function injectBrevity(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "system" && typeof m.content === "string") {
      return { ...m, content: m.content + BREVITY_DIRECTIVE }
    }
    return m
  })
}

export async function callLLM(params: {
  model: string
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionTool[]
}) {
  const messages = injectBrevity(params.messages)
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: params.model,
        messages,
        tools: params.tools.length > 0 ? params.tools : undefined,
        tool_choice: params.tools.length > 0 ? "auto" : undefined,
        temperature: 0.3,
        max_tokens: 1024,
      })
      return { choice: response.choices[0], usage: response.usage ?? null }
    } catch (err: unknown) {
      lastErr = err
      const status = (err as { status?: number }).status
      if (status === 429) {
        // Parse retry-after header if available, otherwise exponential backoff
        const retryAfter = (err as { headers?: { "retry-after"?: string } }).headers?.["retry-after"]
        const waitMs = retryAfter
          ? Math.min(parseInt(retryAfter) * 1000, 120_000)  // cap at 2 min per attempt
          : Math.min(1000 * 2 ** attempt, 60_000)
        console.warn(`[llm] Rate limited (attempt ${attempt}/${MAX_RETRIES}) — waiting ${(waitMs / 1000).toFixed(0)}s...`)
        await Bun.sleep(waitMs)
        continue
      }
      throw err  // non-429 errors fail immediately
    }
  }
  throw lastErr
}

export type { ChatCompletionMessageParam, ChatCompletionTool }
