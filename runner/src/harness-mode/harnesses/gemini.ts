/**
 * Gemini CLI harness adapter.
 *
 * Launches an interactive Gemini session with an initial prompt.
 * Resume uses Gemini's "latest" selector unless a specific session reference
 * was already stored for the run.
 * MCP cfg:   {workingDir}/.gemini/settings.json
 * Context:   {workingDir}/GEMINI.md  (auto-loaded by Gemini CLI)
 */

import { spawn } from "child_process"
import { writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import type { HarnessAdapter, HarnessLaunchConfig, HarnessSession } from "./index.js"

const GEMINI_YOLO_FLAGS = ["--yolo", "--approval-mode", "yolo"] as const

export class GeminiAdapter implements HarnessAdapter {
  readonly name = "gemini"

  async launch(config: HarnessLaunchConfig): Promise<HarnessSession> {
    mkdirSync(config.workingDir, { recursive: true })

    writeFileSync(join(config.workingDir, "GEMINI.md"), config.contextDoc, "utf8")

    const geminiDir = join(config.workingDir, ".gemini")
    mkdirSync(geminiDir, { recursive: true })
    writeFileSync(
      join(geminiDir, "settings.json"),
      JSON.stringify({ mcpServers: config.mcpServers }, null, 2),
      "utf8"
    )

    const args: string[] = []
    if (config.resuming) args.push("--resume", config.sessionId ?? "latest")
    if (config.model) args.push("--model", config.model)
    args.push(...GEMINI_YOLO_FLAGS, "--prompt-interactive", config.initialPrompt)

    const proc = spawn("gemini", args, {
      cwd: config.workingDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env },
    })

    return {
      process: proc,
      sessionId: config.sessionId ?? (config.resuming ? "latest" : undefined),
      waitForExit: () => new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 1))),
    }
  }
}
