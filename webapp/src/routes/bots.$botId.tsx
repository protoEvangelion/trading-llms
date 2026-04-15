import { createFileRoute, Link } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts"
import { getDecisions, getPnlHistory } from "../lib/db.server"
import { readFileSync } from "fs"
import { join } from "path"

// ── server functions ──────────────────────────────────────────────────────────

const getBotData = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(({ data: botId }) => {
    const decisions = getDecisions(botId, 50)
    const pnlHistory = getPnlHistory(botId, 500)
    const raw = readFileSync(join(import.meta.dirname, "../../../bots.json"), "utf8")
    const botsConfig = JSON.parse(raw) as { bots: Array<{ id: string; name: string; description: string; cron: string; model: string; system_prompt: string }> }
    const config = botsConfig.bots.find((b) => b.id === botId)
    return { decisions, pnlHistory, config }
  })

// ── component ─────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/bots/$botId")({
  component: BotDetail,
  loader: async ({ params }) => getBotData({ data: params.botId }),
})

function BotDetail() {
  const { decisions, pnlHistory, config } = Route.useLoaderData()
  const { botId } = Route.useParams()

  const chartData = pnlHistory.map((p: typeof pnlHistory[number]) => ({
    timestamp: p.sim_date ?? p.timestamp,
    returnPct: ((p.portfolio_value - 100_000) / 100_000) * 100,
    spyPct: p.spy_value != null ? ((p.spy_value - 100_000) / 100_000) * 100 : undefined,
  }))

  const latestPnl = pnlHistory[pnlHistory.length - 1]

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link to="/" className="text-gray-500 hover:text-white transition-colors text-sm">
            ← Back
          </Link>
          <span className="text-gray-700">/</span>
          <h1 className="text-2xl font-bold text-white">
            {config?.name ?? botId}
          </h1>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Portfolio Value"
            value={
              latestPnl
                ? `$${latestPnl.portfolio_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
          <StatCard
            label="Cash"
            value={
              latestPnl
                ? `$${latestPnl.cash.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
          <StatCard
            label="Total Return"
            value={
              latestPnl
                ? `${(((latestPnl.portfolio_value - 100_000) / 100_000) * 100).toFixed(2)}%`
                : "—"
            }
            positive={latestPnl ? latestPnl.portfolio_value >= 100_000 : null}
          />
          <StatCard label="Total Decisions" value={decisions.length.toString()} />
        </div>

        {/* P&L Chart */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
          <h2 className="text-base font-semibold text-white mb-1">Return vs SPY</h2>
          <p className="text-xs text-gray-500 mb-4">% return relative to $100,000 starting capital</p>
          {chartData.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-500">No data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData}>
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(v) => v.slice(0, 10)}
                  tick={{ fill: "#6b7280", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v) => `${v.toFixed(1)}%`}
                  tick={{ fill: "#6b7280", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  domain={["auto", "auto"]}
                />
                <Tooltip
                  contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8 }}
                  labelFormatter={(v) => String(v).slice(0, 10)}
                  formatter={(v) => [typeof v === "number" ? `${v.toFixed(2)}%` : "—"]}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="returnPct"
                  name={config?.name ?? botId}
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="spyPct"
                  name="SPY (benchmark)"
                  stroke="#6b7280"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* System prompt / thesis */}
        {config && (
          <details className="bg-gray-900 border border-gray-800 rounded-xl mb-6 group/thesis">
            <summary className="flex items-center justify-between px-6 py-4 cursor-pointer list-none">
              <div>
                <h2 className="text-base font-semibold text-white">Thesis / System Prompt</h2>
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-1 max-w-xl">
                  {config.system_prompt.split("\n\n")[0]}
                </p>
              </div>
              <span className="text-xs text-gray-600 group-open/thesis:rotate-180 transition-transform ml-4 shrink-0">▼</span>
            </summary>
            <div className="px-6 pb-6 border-t border-gray-800 pt-4">
              <pre className="text-sm text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">
                {config.system_prompt}
              </pre>
              <div className="flex gap-4 mt-4 text-xs text-gray-500">
                <span>Model: <span className="text-gray-300">{config.model}</span></span>
                <span>Cron: <span className="text-gray-300 font-mono">{config.cron}</span></span>
              </div>
            </div>
          </details>
        )}

        {/* Decision log */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-4">Decision Log</h2>
          <div className="space-y-4">
            {decisions.length === 0 && (
              <p className="text-gray-500 text-sm">No decisions yet.</p>
            )}
            {decisions.map((d) => {
              const toolCalls = JSON.parse(d.tool_calls || "[]") as Array<{
                tool: string
                args: unknown
                result: string
              }>
              const errorCalls = toolCalls.filter((tc) => isToolError(tc.result))
              const displayDate = d.sim_date
                ? `${d.sim_date} (sim)`
                : new Date(d.timestamp).toLocaleString()
              return (
                <details key={d.id} className="border border-gray-800 rounded-lg overflow-hidden group">
                  <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800/50 transition-colors list-none">
                    <ActionBadge action={d.action} />
                    {d.symbol && (
                      <span className="text-white font-semibold">{d.symbol}</span>
                    )}
                    {d.amount && (
                      <span className="text-gray-400 text-sm">
                        ${d.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </span>
                    )}
                    {errorCalls.length > 0 && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-950 text-red-400">
                        {errorCalls.length} error{errorCalls.length > 1 ? "s" : ""}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-gray-500">{displayDate}</span>
                    <span className="text-xs text-gray-600 group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <div className="px-4 pb-4 border-t border-gray-800 pt-3 space-y-3">
                    {d.reasoning && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-1">Reasoning</p>
                        <p className="text-sm text-gray-300 leading-relaxed">{d.reasoning}</p>
                      </div>
                    )}
                    {toolCalls.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-2">
                          Tool calls ({toolCalls.length})
                        </p>
                        <div className="space-y-2">
                          {toolCalls.map((tc, i) => {
                            const hasError = isToolError(tc.result)
                            return (
                              <details key={i} className={`rounded-lg overflow-hidden group/tc ${hasError ? "bg-red-950/30 border border-red-900/50" : "bg-gray-950"}`}>
                                <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none hover:bg-gray-900/50 transition-colors">
                                  <span className={`text-xs font-mono ${hasError ? "text-red-400" : "text-indigo-400"}`}>{tc.tool}</span>
                                  {hasError && <span className="text-xs text-red-500">error</span>}
                                  <span className="ml-auto text-xs text-gray-600 group-open/tc:rotate-180 transition-transform">▼</span>
                                </summary>
                                <div className="px-3 pb-3 border-t border-gray-800/50 pt-2">
                                  <p className={`text-xs whitespace-pre-wrap font-mono leading-relaxed ${hasError ? "text-red-400" : "text-gray-400"}`}>{tc.result}</p>
                                </div>
                              </details>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </details>
              )
            })}
          </div>
        </div>
      </div>
    </main>
  )
}

function StatCard({
  label,
  value,
  positive,
}: {
  label: string
  value: string
  positive?: boolean | null
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p
        className={`text-xl font-bold ${
          positive === true
            ? "text-emerald-400"
            : positive === false
              ? "text-red-400"
              : "text-white"
        }`}
      >
        {value}
      </p>
    </div>
  )
}

function isToolError(result: string): boolean {
  return /^Error|403|401|error \d{3}/i.test(result)
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    buy_stock: "bg-emerald-950 text-emerald-400",
    sell_stock: "bg-red-950 text-red-400",
    do_nothing: "bg-gray-800 text-gray-400",
    error: "bg-yellow-950 text-yellow-400",
  }
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${styles[action] ?? "bg-gray-800 text-gray-400"}`}
    >
      {action.replace("_", " ")}
    </span>
  )
}
