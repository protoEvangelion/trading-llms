import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources"

// Groq is OpenAI-compatible — just swap the base URL and API key
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
})

export async function callLLM(params: {
  model: string
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionTool[]
}) {
  const response = await client.chat.completions.create({
    model: params.model,
    messages: params.messages,
    tools: params.tools.length > 0 ? params.tools : undefined,
    tool_choice: params.tools.length > 0 ? "auto" : undefined,
    temperature: 0.3,
    max_tokens: 4096,
  })

  return response.choices[0]
}

export type { ChatCompletionMessageParam, ChatCompletionTool }
