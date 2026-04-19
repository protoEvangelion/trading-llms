import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { readSimDate } from "./sim-clock.js"

describe("readSimDate", () => {
  test("reads the current trading day from the shared state file", () => {
    const dir = mkdtempSync("/tmp/trading-bots-sim-clock-")
    const stateFile = join(dir, "clock.json")

    try {
      writeFileSync(
        stateFile,
        JSON.stringify({
          runId: 7,
          mode: "backtest",
          tradingDays: ["2026-04-10", "2026-04-11", "2026-04-14"],
          currentDayIndex: 1,
          completed: false,
        }),
        "utf8"
      )

      expect(readSimDate(stateFile)).toBe("2026-04-11")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null when the state file cannot be read", () => {
    expect(readSimDate("/tmp/does-not-exist-sim-clock.json")).toBeNull()
  })
})
