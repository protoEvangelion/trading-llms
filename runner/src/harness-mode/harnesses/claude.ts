/**
 * Claude Code CLI harness adapter.
 *
 * Launches an interactive Claude Code session seeded with an initial prompt.
 * Resume uses the working directory-local session history unless a concrete
 * session ID is available.
 * MCP cfg:   {workingDir}/.claude/settings.json
 * Context:   {workingDir}/CLAUDE.md  (auto-loaded by Claude Code)
 */

import { spawn } from "child_process"
import { writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import type { HarnessAdapter, HarnessLaunchConfig, HarnessSession } from "./index.js"

const CLAUDE_YOLO_FLAGS = ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"] as const

export class ClaudeAdapter implements HarnessAdapter {
  readonly name = "claude"

  async launch(config: HarnessLaunchConfig): Promise<HarnessSession> {
    mkdirSync(config.workingDir, { recursive: true })

    writeFileSync(join(config.workingDir, "CLAUDE.md"), config.contextDoc, "utf8")

    const claudeDir = join(config.workingDir, ".claude")
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ mcpServers: config.mcpServers }, null, 2),
      "utf8"
    )

    const args: string[] = []
    if (config.resuming) {
      if (config.sessionId) args.push("--resume", config.sessionId)
      else args.push("--continue")
    }
    args.push(...CLAUDE_YOLO_FLAGS)
    if (config.model) args.push("--model", config.model)
    args.push(config.initialPrompt)

    const proc = spawn("claude", args, {
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
