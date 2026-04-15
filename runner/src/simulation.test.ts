import { describe, expect, test } from "bun:test"
import {
  capEnd,
  calculateMaxDrawdown,
  getCronHours,
  getCronMinute,
  getSimDateTimes,
} from "./simulation.js"

describe("capEnd", () => {
  test("returns queryDate when desiredEnd is after it", () => {
    // This is the bug we hit: date=Apr 10, desiredEnd=Apr 14 → 403
    expect(capEnd("2026-04-14", "2026-04-10")).toBe("2026-04-10")
  })

  test("returns desiredEnd when it's before queryDate", () => {
    expect(capEnd("2026-04-08", "2026-04-10")).toBe("2026-04-08")
  })

  test("returns queryDate when they are equal", () => {
    expect(capEnd("2026-04-10", "2026-04-10")).toBe("2026-04-10")
  })
})

describe("calculateMaxDrawdown", () => {
  test("returns 0 for a single value", () => {
    expect(calculateMaxDrawdown([100_000])).toBe(0)
  })

  test("calculates drawdown correctly", () => {
    // Peak 100k → trough 90k = 10% drawdown
    const dd = calculateMaxDrawdown([100_000, 105_000, 90_000, 95_000])
    expect(dd).toBeCloseTo(0.1429, 3) // (105k - 90k) / 105k
  })

  test("returns 0 for a monotonically increasing series", () => {
    expect(calculateMaxDrawdown([90_000, 95_000, 100_000])).toBe(0)
  })
})

describe("getCronHours", () => {
  test("parses step expression", () => {
    expect(getCronHours("0 */4 * * 1-5")).toEqual([0, 4, 8, 12, 16, 20])
  })

  test("parses list expression", () => {
    expect(getCronHours("45 3,7,11,15,19 * * 1-5")).toEqual([3, 7, 11, 15, 19])
  })

  test("parses single hour", () => {
    expect(getCronHours("0 10 * * 1-5")).toEqual([10])
  })

  test("falls back to [9] for invalid expression", () => {
    expect(getCronHours("bad")).toEqual([9])
  })
})

describe("getCronMinute", () => {
  test("parses minute from expression", () => {
    expect(getCronMinute("45 9 * * 1-5")).toBe(45)
  })

  test("returns 0 for wildcard minute", () => {
    expect(getCronMinute("0 9 * * 1-5")).toBe(0)
  })
})

describe("getSimDateTimes", () => {
  test("builds datetime strings from cron", () => {
    const result = getSimDateTimes("2026-04-10", "15 9 * * 1-5")
    expect(result).toEqual(["2026-04-10T09:15:00"])
  })

  test("builds multiple ticks per day for intraday cron", () => {
    const result = getSimDateTimes("2026-04-10", "0 */4 * * 1-5")
    expect(result).toHaveLength(6)
    expect(result[0]).toBe("2026-04-10T00:00:00")
    expect(result[1]).toBe("2026-04-10T04:00:00")
  })
})
