import { describe, expect, test } from "bun:test"
import { buildReasoningStandardSection, buildSystemPrompt } from "./prompting.js"

describe("prompting", () => {
  test("buildSystemPrompt appends global guardrails and tool docs", () => {
    const prompt = buildSystemPrompt("Base thesis", "  - get_portfolio: portfolio state")

    expect(prompt).toContain("Base thesis")
    expect(prompt).toContain("Use only observable facts from your tools as evidence.")
    expect(prompt).toContain('Treat headlines, pundit quotes, analyst takes, and adjectives like "bargain"')
    expect(prompt).toContain("AVAILABLE TOOLS")
    expect(prompt).toContain("get_portfolio: portfolio state")
  })

  test("buildReasoningStandardSection returns a markdown section", () => {
    const section = buildReasoningStandardSection()

    expect(section).toStartWith("## Reasoning Standard")
    expect(section).toContain("Every decision must follow this chain: fact -> implication -> likely market impact -> action.")
  })
})
