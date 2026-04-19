/**
 * Harness-mode CLI entry point.
 *
 * Usage:
 *   bun run runner/src/harness.ts --harness=<claude|gemini|copilot> --thesis=<botId|alias> --mode=<backtest|paper|live> [flags]
 *
 * Flags:
 *   --harness=<name>          Required. claude | gemini | copilot
 *   --thesis=<botId>          Required. Bot ID from bots.ts (e.g. trump-bot) or a short alias (e.g. trump)
 *   --mode=<mode>             Required. backtest | paper | live
 *   --start=YYYY-MM-DD        Required for backtest. Start date.
 *   --end=YYYY-MM-DD          Required for backtest. End date.
 *   --model=<id>              Required. Model passed to the harness CLI.
 *   --resume                  Optional. Resume the last running session for this thesis+mode.
 */

import { runHarness, type HarnessRunConfig } from "./harness-mode/runner.js"
import { getDb } from "./db.js"
import type { HarnessName } from "./harness-mode/harnesses/index.js"
import { resolve } from "path"

// Load .env from project root
const envFile = Bun.file(new URL("../../.env", import.meta.url))
if (await envFile.exists()) {
  const content = await envFile.text()
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const [key, ...rest] = trimmed.split("=")
    if (key && rest.length > 0) process.env[key.trim()] = rest.join("=").trim()
  }
}

function arg(prefix: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`${prefix}=`))?.split("=").slice(1).join("=")
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

function usage(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`)
  console.error(`Usage:
  bun run runner/src/harness.ts --harness=<claude|gemini|copilot> --thesis=<botId|alias> --mode=<backtest|paper|live> [options]

Options:
  --start=YYYY-MM-DD    Backtest start date (required for fresh backtests)
  --end=YYYY-MM-DD      Backtest end date   (required for fresh backtests)
  --model=<id>          Model passed to the harness CLI
  --resume              Resume the last running session for this thesis+harness+mode

Examples:
  bun run runner/src/harness.ts --harness=claude --model=claude-sonnet-4 --thesis=trump-bot --mode=backtest --start=2025-01-01 --end=2025-03-01
  bun run runner/src/harness.ts --harness=gemini --model=gemini-2.5-pro --thesis=datacenter --mode=paper
  bun run runner/src/harness.ts --harness=copilot --model=gpt-5.4 --thesis=trump --mode=paper --resume`)
  process.exit(1)
}

async function main() {
  const harness = arg("--harness") as HarnessName | undefined
  const botId   = arg("--thesis")
  const mode    = arg("--mode") as HarnessRunConfig["mode"] | undefined
  const model   = arg("--model")
  const start   = arg("--start")
  const end     = arg("--end")
  const resume  = flag("--resume")

  if (!harness) usage("--harness is required")
  if (!["claude", "gemini", "copilot"].includes(harness!)) usage(`Unknown harness "${harness}". Must be claude | gemini | copilot`)
  if (!botId) usage("--thesis is required")
  if (!mode) usage("--mode is required")
  if (!model) usage("--model is required")
  if (!["backtest", "paper", "live"].includes(mode!)) usage(`Unknown mode "${mode}". Must be backtest | paper | live`)

  if (mode === "backtest") {
    if (!resume && !start) usage("--start=YYYY-MM-DD is required for fresh backtest runs")
    if (!resume && !end) usage("--end=YYYY-MM-DD is required for fresh backtest runs")
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) usage("--start must be YYYY-MM-DD")
    if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) usage("--end must be YYYY-MM-DD")
    if (start && end && start >= end) usage("--start must be before --end")
  }

  // Set TRADING_ENV before first getDb() call
  process.env.TRADING_ENV = mode === "backtest" ? "dev" : mode === "paper" ? "staging" : "prod"
  process.env.TRADING_BOTS_DATA_DIR = resolve(import.meta.dir, "../../data")

  console.log(`[harness-cli] env: ${process.env.TRADING_ENV}`)
  getDb()  // run migrations

  const config: HarnessRunConfig = {
    harness: harness!,
    model: model!,
    botId: botId!,
    mode: mode!,
    startDate: start,
    endDate: end,
    resume,
  }

  try {
    await runHarness(config)
  } catch (err) {
    console.error("[harness-cli] Fatal:", err)
    process.exit(1)
  }
}

main()
