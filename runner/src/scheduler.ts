import { Cron } from "croner"
import { runBot } from "./bot-runner.js"
import type { BotConfig } from "./bot-runner.js"

const activeJobs = new Map<string, Cron>()

export function scheduleBot(bot: BotConfig & { cron: string; enabled: boolean }) {
  if (!bot.enabled) {
    console.log(`[scheduler] ${bot.id} is disabled — skipping`)
    return
  }

  console.log(`[scheduler] Scheduling ${bot.id} → cron: "${bot.cron}" (ET)`)

  const job = new Cron(
    bot.cron,
    { timezone: "America/New_York", protect: true },
    async () => {
      console.log(`[scheduler] Firing ${bot.id}`)
      try {
        await runBot(bot)
      } catch (err) {
        console.error(`[scheduler] ${bot.id} run threw:`, err)
      }
    }
  )

  activeJobs.set(bot.id, job)

  const next = job.nextRun()
  console.log(`[scheduler] ${bot.id} next run: ${next?.toLocaleString("en-US", { timeZone: "America/New_York" })} ET`)
}

export async function triggerBotNow(botId: string, bots: (BotConfig & { cron: string; enabled: boolean })[]) {
  const bot = bots.find((b) => b.id === botId)
  if (!bot) throw new Error(`Bot ${botId} not found`)
  console.log(`[scheduler] Manual trigger: ${botId}`)
  await runBot(bot)
}

export function stopAll() {
  for (const [id, job] of activeJobs) {
    job.stop()
    console.log(`[scheduler] Stopped ${id}`)
  }
  activeJobs.clear()
}
