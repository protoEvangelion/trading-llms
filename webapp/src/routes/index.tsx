import { createFileRoute, Link } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts"
import { readFileSync } from "fs"
import { join } from "path"
import { getAllBotSummaries, getPnlHistory } from "../lib/db.server"

function loadBotsConfig() {
  const raw = readFileSync(join(import.meta.dirname, "../../../bots.json"), "utf8")
  return JSON.parse(raw) as { bots: Array<{ id: string; name: string; description: string; cron: string; model: string }> }
}

// ── server functions ──────────────────────────────────────────────────────────

const getBotSummaries = createServerFn({ method: "GET" }).handler(() => {
  const botsConfig = loadBotsConfig()
  const botIds = botsConfig.bots.map((b) => b.id)
  const summaries = getAllBotSummaries(botIds)
  return summaries.map((s) => {
    const cfg = botsConfig.bots.find((b) => b.id === s.id)
    return { ...s, name: cfg?.name ?? s.id, description: cfg?.description ?? "", cron: cfg?.cron ?? "", model: cfg?.model ?? "" }
  })
})

const getChartData = createServerFn({ method: "GET" }).handler(() => {
  const botsConfig = loadBotsConfig()
  const botIds = botsConfig.bots.map((b) => b.id)
  const histories = botIds.map((id) => ({ id, data: getPnlHistory(id, 500) }))

  const allTimestamps = [
    ...new Set(histories.flatMap((h) => h.data.map((p) => p.timestamp))),
  ].sort()

  return allTimestamps.map((ts) => {
    const row: Record<string, unknown> = { timestamp: ts }
    for (const { id, data } of histories) {
      const point = data.find((p) => p.timestamp === ts)
      if (point) {
        row[id] = ((point.portfolio_value - 100_000) / 100_000) * 100
      }
    }
    return row
  })
})

// ── component ─────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/")({
  component: Dashboard,
  loader: async () => {
    const [summaries, chartData] = await Promise.all([
      getBotSummaries(),
      getChartData(),
    ])
    return { summaries, chartData }
  },
})

const BOT_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"]

function Dashboard() {
  const { summaries, chartData } = Route.useLoaderData()
  const botIds = summaries.map((s) => s.id)

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white">Trading Bot Race</h1>
          <p className="text-gray-400 mt-1">Live paper trading — bots racing each other on thesis-driven strategies</p>
        </div>

        {/* Bot cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {summaries.map((bot, i) => (
            <Link key={bot.id} to="/bots/$botId" params={{ botId: bot.id }}>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-600 transition-colors cursor-pointer">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ background: BOT_COLORS[i % BOT_COLORS.length] }}
                      />
                      <h2 className="font-semibold text-white">{bot.name}</h2>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{bot.model}</p>
                  </div>
                  <ReturnBadge value={bot.totalReturn} />
                </div>

                <p className="text-sm text-gray-400 mb-4 line-clamp-2">{bot.description}</p>

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
                        ? "text-emerald-400"
                        : bot.lastDecision?.action === "sell_stock"
                          ? "text-red-400"
                          : "text-gray-400"
                    }
                  />
                </div>

                {bot.lastDecision && (
                  <p className="mt-3 text-xs text-gray-500 line-clamp-2">
                    {new Date(bot.lastDecision.timestamp).toLocaleString()} —{" "}
                    {bot.lastDecision.reasoning?.slice(0, 120)}...
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>

        {/* Race chart */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-1">Portfolio Return (%)</h2>
          <p className="text-sm text-gray-500 mb-6">Relative to $100,000 starting capital</p>

          {chartData.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-gray-500">
              No data yet — run a bot first
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData}>
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(v) => new Date(v).toLocaleDateString()}
                  tick={{ fill: "#6b7280", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v) => `${v.toFixed(1)}%`}
                  tick={{ fill: "#6b7280", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8 }}
                  labelFormatter={(v) => new Date(v).toLocaleString()}
                  formatter={(v: number) => [`${v.toFixed(2)}%`]}
                />
                <Legend />
                {botIds.map((id, i) => (
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
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </main>
  )
}

function ReturnBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-full">No data</span>
  const positive = value >= 0
  return (
    <span
      className={`text-xs font-semibold px-2 py-1 rounded-full ${
        positive ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
      }`}
    >
      {positive ? "+" : ""}{value.toFixed(2)}%
    </span>
  )
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`font-medium ${className ?? "text-white"}`}>{value}</p>
    </div>
  )
}
