/**
 * GitHub Copilot CLI harness adapter.
 *
 * Install:   npm install -g @github/copilot
 * Launches an interactive autopilot session with the run-specific config dir.
 * Resume uses --continue unless a concrete session ID is already known.
 * MCP cfg:   {workingDir}/mcp-config.json  (Copilot reads this when --config-dir is set)
 * Context:   {workingDir}/COPILOT.md plus AGENTS.md for Copilot's native instructions loader
 *
 * Copilot CLI MCP format requires type:"local" and tools:["*"] in addition to
 * the standard command/args/env fields.
 */

import { spawn } from "child_process"
import { writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import type { HarnessAdapter, HarnessLaunchConfig, HarnessSession, McpServerSpec } from "./index.js"

const COPILOT_YOLO_FLAGS = ["--autopilot", "--yolo"] as const

interface CopilotMcpEntry {
  type: "local"
  command: string
  args?: string[]
  env?: Record<string, string>
  tools: ["*"]
}

function toCopilotFormat(servers: Record<string, McpServerSpec>): Record<string, CopilotMcpEntry> {
  const out: Record<string, CopilotMcpEntry> = {}
  for (const [name, spec] of Object.entries(servers)) {
    out[name] = { type: "local", command: spec.command, args: spec.args, env: spec.env, tools: ["*"] }
  }
  return out
}

export class CopilotAdapter implements HarnessAdapter {
  readonly name = "copilot"

  async launch(config: HarnessLaunchConfig): Promise<HarnessSession> {
    mkdirSync(config.workingDir, { recursive: true })

    writeFileSync(join(config.workingDir, "COPILOT.md"), config.contextDoc, "utf8")
    writeFileSync(join(config.workingDir, "AGENTS.md"), config.contextDoc, "utf8")

    writeFileSync(
      join(config.workingDir, "mcp-config.json"),
      JSON.stringify({ mcpServers: toCopilotFormat(config.mcpServers) }, null, 2),
      "utf8"
    )

    const args: string[] = []
    if (config.resuming) {
      if (config.sessionId) args.push("--resume", config.sessionId)
      else args.push("--continue")
    }
    if (config.model) args.push("--model", config.model)
    args.push(...COPILOT_YOLO_FLAGS, "--config-dir", config.workingDir, "-i", config.initialPrompt)

    const proc = spawn("copilot", args, {
      cwd: config.workingDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env },
    })

    return {
      process: proc,
      sessionId: config.sessionId,
      waitForExit: () => new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 1))),
    }
  }
}
