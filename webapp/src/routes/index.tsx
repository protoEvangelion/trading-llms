import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Chip,
} from "@heroui/react"
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts"
import { readFileSync } from "fs"
import { join } from "path"
import { getAllBotSummaries, getBacktestComparisonSeries, getPnlHistory } from "../lib/db.server"
import ModeSelect from "../components/ModeSelect"
import {
  getAppModeDescription,
  getAppModeLabel,
  normalizeAppMode,
  type AppMode,
} from "../lib/mode"

function loadBotsConfig() {
  const raw = readFileSync(join(import.meta.dirname, "../../../bots.json"), "utf8")
  return JSON.parse(raw) as { bots: Array<{ id: string; name: string; description: string; cron: string; model: string }> }
}

// ── server functions ──────────────────────────────────────────────────────────

const getBotSummaries = createServerFn({ method: "GET" })
  .inputValidator((data: { mode: AppMode }) => data)
  .handler(({ data }) => {
    const botsConfig = loadBotsConfig()
    const botIds = botsConfig.bots.map((b) => b.id)
    const summaries = getAllBotSummaries(botIds, data.mode)
    return summaries.map((s) => {
      const cfg = botsConfig.bots.find((b) => b.id === s.id)
      return {
        ...s,
        name: cfg?.name ?? s.id,
        description: cfg?.description ?? "",
        cron: cfg?.cron ?? "",
        model: cfg?.model ?? "",
      }
    })
  })

const getChartData = createServerFn({ method: "GET" })
  .inputValidator((data: { mode: AppMode }) => data)
  .handler(({ data }) => {
    const botsConfig = loadBotsConfig()
    const botIds = botsConfig.bots.map((b) => b.id)
    const summaries = getAllBotSummaries(botIds, data.mode)
    const histories = data.mode === "backtesting"
      ? botIds
          .map((botId) => {
            const comparison = getBacktestComparisonSeries(botId, 500)
            return {
              summary: summaries.find((summary) => summary.id === botId) ?? null,
              runMeta: comparison.runMeta,
              points: comparison.history,
            }
          })
          .filter((entry): entry is {
            summary: NonNullable<(typeof summaries)[number]>
            runMeta: NonNullable<ReturnType<typeof getBacktestComparisonSeries>["runMeta"]>
            points: ReturnType<typeof getBacktestComparisonSeries>["history"]
          } => entry.summary !== null && entry.runMeta !== null && entry.points.length > 0)
      : summaries
          .map((summary) => ({
            summary,
            runMeta: summary.runMeta,
            points: getPnlHistory(summary.id, data.mode, 500),
          }))
          .filter(({ points }) => points.length > 0)

    const referenceHistory = histories
      .slice()
      .sort((left, right) => {
        if (data.mode === "backtesting") {
          const leftEnd = left.runMeta?.simEnd ?? ""
          const rightEnd = right.runMeta?.simEnd ?? ""
          if (leftEnd !== rightEnd) return rightEnd.localeCompare(leftEnd)

          const leftCompleted = left.runMeta?.completedAt ?? ""
          const rightCompleted = right.runMeta?.completedAt ?? ""
          if (leftCompleted !== rightCompleted) return rightCompleted.localeCompare(leftCompleted)
        }

        const leftLatest = left.points[left.points.length - 1]?.timestamp ?? ""
        const rightLatest = right.points[right.points.length - 1]?.timestamp ?? ""
        if (leftLatest !== rightLatest) return rightLatest.localeCompare(leftLatest)

        return right.points.length - left.points.length
      })[0]

    const allTimestamps = [
      ...new Set(histories.flatMap((history) => history.points.map((point) => point.sim_date ?? point.timestamp))),
      ...(referenceHistory
        ? referenceHistory.points.map((point) => point.sim_date ?? point.timestamp)
        : []),
    ].sort()

    const pointMaps = new Map(
      histories.map(({ summary, points }) => [
        summary.id,
        new Map(points.map((point) => [point.sim_date ?? point.timestamp, point])),
      ])
    )
    const referencePoints = referenceHistory
      ? new Map(referenceHistory.points.map((point) => [point.sim_date ?? point.timestamp, point]))
      : null

    return {
      botIds: histories.map(({ summary }) => summary.id),
      rows: allTimestamps.map((ts) => {
        const row: Record<string, string | number> = { timestamp: ts }
        for (const { summary } of histories) {
          const point = pointMaps.get(summary.id)?.get(ts)
          if (point) {
            row[summary.id] = ((point.portfolio_value - 100_000) / 100_000) * 100
          }
        }

        const referencePoint = referencePoints?.get(ts)
        if (referencePoint?.spy_value != null) {
          row["SPY"] = ((referencePoint.spy_value - 100_000) / 100_000) * 100
        }
        return row
      }),
    }
  })

// ── component ─────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    mode: normalizeAppMode(search.mode),
  }),
  loaderDeps: ({ search }) => ({ mode: search.mode }),
  component: Dashboard,
  loader: async ({ deps }) => {
    const [summaries, chart] = await Promise.all([
      getBotSummaries({ data: { mode: deps.mode } }),
      getChartData({ data: { mode: deps.mode } }),
    ])
    return { summaries, chart, mode: deps.mode }
  },
})

const BOT_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"]

function Dashboard() {
  const navigate = useNavigate({ from: Route.fullPath })
  const { summaries, chart, mode } = Route.useLoaderData()
  const chartBotIds = chart.botIds

  return (
    <main className="min-h-screen px-4 pb-10 pt-6 text-gray-100 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              {getAppModeLabel(mode)}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Trading Bot Race
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-400 sm:text-base">
              {mode === "backtesting"
                ? "Latest completed backtests that span a full year, plotted against one canonical SPY benchmark series."
                : getAppModeDescription(mode)}
            </p>
          </div>
          <ModeSelect
            value={mode}
            onChange={(nextMode) => navigate({ search: { mode: nextMode } })}
          />
        </div>

        {/* Bot cards */}
        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {summaries.map((bot, i) => (
            <Link key={bot.id} to="/bots/$botId" params={{ botId: bot.id }} search={{ mode }}>
              <Card className="glass-card-soft h-full rounded-[24px] border-white/10 transition-transform duration-200 hover:-translate-y-1 hover:border-white/20">
                <CardHeader className="flex items-start justify-between gap-4 p-5 pb-3">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center gap-3">
                      <div
                        className="h-3 w-3 rounded-full ring-4 ring-white/5"
                        style={{ background: BOT_COLORS[i % BOT_COLORS.length] }}
                      />
                      <CardTitle className="truncate text-base font-semibold text-white">{bot.name}</CardTitle>
                    </div>
                    <CardDescription className="text-xs text-slate-500">
                      {bot.runMeta?.simStart && bot.runMeta?.simEnd
                        ? `${bot.runMeta.simStart} -> ${bot.runMeta.simEnd}`
                        : bot.cron || "No schedule configured"}
                    </CardDescription>
                  </div>
                  <PerformanceSummary
                    totalReturn={bot.totalReturn}
                    spyReturn={bot.spyReturn}
                    returnVsSpy={bot.returnVsSpy}
                  />
                </CardHeader>
                <CardContent className="px-5 pb-3">
                  <p className="mb-5 line-clamp-2 text-sm leading-6 text-slate-400">{bot.description}</p>
                  <div className="mb-5 flex flex-wrap gap-2">
                    <MetaBadge label="Model" value={bot.runMeta?.model ?? bot.model ?? "None"} />
                    <MetaBadge label="Harness" value={bot.runMeta?.harness ?? "None"} />
                    {mode === "backtesting" && bot.runMeta?.isFullYear && (
                      <Chip
                        className="border border-blue-300/10 bg-blue-400/10 text-blue-100"
                        color="default"
                        variant="soft"
                      >
                        Full year
                      </Chip>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Stat
                      label="Portfolio"
                      value={
                        bot.latestPnl
                          ? `$${bot.latestPnl.portfolio_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                          : "—"
                      }
                    />
                    <Stat
                      label="Cash"
                      value={
                        bot.latestPnl
                          ? `$${bot.latestPnl.cash.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                          : "—"
                      }
                    />
                    <Stat label="Decisions" value={bot.totalDecisions.toString()} />
                    <Stat
                      label="Last action"
                      value={bot.lastDecision?.action ?? "—"}
                      className={
                        bot.lastDecision?.action === "buy_stock"
                          ? "text-emerald-300"
                          : bot.lastDecision?.action === "sell_stock"
                            ? "text-rose-300"
                            : "text-slate-300"
                      }
                    />
                  </div>
                </CardContent>
                {bot.lastDecision && (
                  <CardFooter className="px-5 pb-5 pt-2 text-xs leading-5 text-slate-500">
                    {mode === "backtesting"
                      ? `${bot.lastDecision.sim_date ?? bot.lastDecision.timestamp.slice(0, 10)} — `
                      : `${new Date(bot.lastDecision.timestamp).toLocaleString()} — `}
                    {bot.lastDecision.reasoning?.slice(0, 140)}...
                  </CardFooter>
                )}
              </Card>
            </Link>
          ))}
        </div>

        {/* Race chart */}
        <Card className="glass-card rounded-[28px]">
          <CardHeader className="p-6 pb-2 sm:p-8 sm:pb-3">
            <CardTitle className="text-lg font-semibold text-white">Portfolio Return</CardTitle>
            <CardDescription className="text-sm text-slate-400">
              {mode === "backtesting"
                ? "Latest completed backtests spanning at least 365 days, normalized to $100,000."
                : "Relative to $100,000 starting capital"}
            </CardDescription>
          </CardHeader>

          {chart.rows.length === 0 ? (
            <CardContent className="flex h-48 items-center justify-center p-6 text-slate-500">
              {mode === "backtesting" ? "No full-year backtests yet" : `No ${mode} data yet`}
            </CardContent>
          ) : (
            <CardContent className="p-4 pt-0 sm:px-6 sm:pb-6 sm:pt-0">
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={chart.rows}>
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(v) =>
                      mode === "backtesting" ? String(v).slice(5, 10) : new Date(String(v)).toLocaleDateString()
                    }
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={(v) => `${v.toFixed(1)}%`}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{ background: "#0d1326", border: "1px solid rgba(148, 163, 184, 0.18)", borderRadius: 16 }}
                    labelFormatter={(v) =>
                      mode === "backtesting" ? String(v).slice(0, 10) : new Date(String(v)).toLocaleString()
                    }
                    formatter={(v) => [typeof v === "number" ? `${v.toFixed(2)}%` : "—"]}
                  />
                  <Legend />
                  {chartBotIds.map((id, i) => (
                    <Line
                      key={id}
                      type="monotone"
                      dataKey={id}
                      name={summaries.find((s) => s.id === id)?.name ?? id}
                      stroke={BOT_COLORS[i % BOT_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="SPY"
                    name="SPY (benchmark)"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          )}
        </Card>
      </div>
    </main>
  )
}

function PerformanceSummary({
  totalReturn,
  spyReturn,
  returnVsSpy,
}: {
  totalReturn: number | null
  spyReturn: number | null
  returnVsSpy: number | null
}) {
  if (totalReturn === null) {
    return (
      <Chip className="border border-white/10 bg-white/5 text-slate-400" color="default" variant="soft">
        No data
      </Chip>
    )
  }

  return (
    <div className="flex shrink-0 flex-col items-start gap-1.5 text-left">
      <ReturnBadge value={totalReturn} />
      {spyReturn !== null && returnVsSpy !== null && (
        <p className="text-[11px] font-medium text-slate-400">
          SPY {formatSignedPercent(spyReturn)} <span className="text-slate-600">•</span>{" "}
          <span className={returnVsSpy >= 0 ? "text-emerald-300" : "text-rose-300"}>
            Δ {formatSignedPercent(returnVsSpy)}
          </span>
        </p>
      )}
    </div>
  )
}

function ReturnBadge({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <Chip className="border border-white/10 bg-white/5 text-slate-400" color="default" variant="soft">
        No data
      </Chip>
    )
  }
  const positive = value >= 0
  return (
    <Chip
      className={
        positive
          ? "border border-emerald-300/10 bg-emerald-400/10 text-emerald-200"
          : "border border-rose-300/10 bg-rose-400/10 text-rose-200"
      }
      color="default"
      variant="soft"
    >
      {positive ? "+" : ""}{value.toFixed(2)}%
    </Chip>
  )
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
}

function MetaBadge({ label, value }: { label: string; value: string }) {
  return (
    <Chip className="border border-white/10 bg-white/5 text-slate-300" color="default" variant="soft">
      {label}: {value}
    </Chip>
  )
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className={`mt-1 font-medium ${className ?? "text-white"}`}>{value}</p>
    </div>
  )
}
