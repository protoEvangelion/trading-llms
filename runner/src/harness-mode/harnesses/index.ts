import type { ChildProcess } from "child_process"
import { ClaudeAdapter } from "./claude.js"
import { GeminiAdapter } from "./gemini.js"
import { CopilotAdapter } from "./copilot.js"

/** Harness-agnostic MCP server spec. Each adapter converts this to its own config format. */
export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface HarnessLaunchConfig {
  model: string
  workingDir: string
  contextDoc: string
  mcpServers: Record<string, McpServerSpec>
  initialPrompt: string
  resuming: boolean
  sessionId?: string
}

export interface HarnessSession {
  process: ChildProcess
  sessionId?: string
  waitForExit(): Promise<number>
}

export interface HarnessAdapter {
  readonly name: string
  launch(config: HarnessLaunchConfig): Promise<HarnessSession>
}

export type HarnessName = "claude" | "gemini" | "copilot"

export function getHarnessAdapter(name: HarnessName): HarnessAdapter {
  switch (name) {
    case "claude": return new ClaudeAdapter()
    case "gemini": return new GeminiAdapter()
    case "copilot": return new CopilotAdapter()
  }
}
