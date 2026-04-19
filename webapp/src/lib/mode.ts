export const APP_MODES = ["backtesting", "paper", "live"] as const

export type AppMode = (typeof APP_MODES)[number]

export const DEFAULT_APP_MODE: AppMode = "backtesting"

export function normalizeAppMode(value: unknown): AppMode {
  if (typeof value === "string" && APP_MODES.includes(value as AppMode)) {
    return value as AppMode
  }
  return DEFAULT_APP_MODE
}

export function getAppModeLabel(mode: AppMode): string {
  switch (mode) {
    case "backtesting":
      return "Backtesting"
    case "paper":
      return "Paper"
    case "live":
      return "Live"
  }
}

export function getAppModeDescription(mode: AppMode): string {
  switch (mode) {
    case "backtesting":
      return "Latest completed backtest for each bot"
    case "paper":
      return "Paper trading data from staging"
    case "live":
      return "Live trading data from prod"
  }
}
