/**
 * Bot registry — imports all bot definitions and re-exports them.
 *
 * To add a new bot: create a file in bots/ and add it to the array below.
 */

import type { BotConfig } from "./bot-runner.js"

/** A fully-configured bot including scheduling metadata */
export interface ScheduledBotConfig extends BotConfig {
  /** Standard 5-field cron expression, evaluated in America/New_York */
  cron: string
  /** Set to false to prevent this bot from being scheduled */
  enabled: boolean
  /**
   * Optional command to run before the bot fires each scheduled tick.
   * Runs as a child process; failure is logged but does NOT abort the bot run.
   * Example: ["bun", "run", "scripts/scrape-trump-posts.ts", "--update"]
   */
  preRunScript?: string[]
}

export { trumpBot } from "./bots/trump-bot.js"
export { dataCenterBot } from "./bots/datacenter-bot.js"
export { claudeBot } from "./bots/claude-bot.js"
export { volCrushBot } from "./bots/vol-crush-bot.js"

import { trumpBot } from "./bots/trump-bot.js"
import { dataCenterBot } from "./bots/datacenter-bot.js"
import { claudeBot } from "./bots/claude-bot.js"
import { volCrushBot } from "./bots/vol-crush-bot.js"

/** All registered bots. The runner schedules every bot with enabled: true. */
export const bots: ScheduledBotConfig[] = [trumpBot, dataCenterBot, claudeBot, volCrushBot]
