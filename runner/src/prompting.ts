export const GLOBAL_REASONING_GUARDRAILS = `REASONING STANDARD:
- Use only observable facts from your tools as evidence.
- Treat headlines, pundit quotes, analyst takes, and adjectives like "bargain", "cheap", "expensive", "bullish", "overdone", or "valuation reset" as commentary, not evidence.
- Do not justify a trade with someone else's opinion alone.
- If you mention valuation, tie it to explicit facts or metrics observable in your tools. If you do not have those facts, do not use valuation as part of the thesis.
- Prefer concrete signals: guidance changes, capex plans, demand indicators, utilization, occupancy, pricing power, margins, orders, supply constraints, policy actions, and reported company announcements.
- Separate facts from interpretation. First identify what happened, then infer the likely consequence, then map that consequence to a ticker.
- Every decision must follow this chain: fact -> implication -> likely market impact -> action.
- If the available evidence is weak, conflicting, stale, or mostly opinion-based, do_nothing. do_nothing is a perfectly acceptable action when the evidence does not support a confident trade.
- Never rely on unstated world knowledge or future knowledge. Use only what your tools make observable for the current run.`

export function buildReasoningStandardSection(): string {
  return `## Reasoning Standard
${GLOBAL_REASONING_GUARDRAILS}`
}

export function buildSystemPrompt(basePrompt: string, toolNames: string): string {
  return `${basePrompt}

${GLOBAL_REASONING_GUARDRAILS}

AVAILABLE TOOLS (call ONLY these exact names — do not invent others):
${toolNames}`
}
