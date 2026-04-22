import ReactMarkdown from "react-markdown"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Chip,
} from "@heroui/react"
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts"
import { getAllBotSummaries, getDecisions, getPnlHistory } from "../lib/db.server"
import { readFileSync } from "fs"
import { join } from "path"
import ModeSelect from "../components/ModeSelect"
import {
  getAppModeDescription,
  getAppModeLabel,
  normalizeAppMode,
  type AppMode,
} from "../lib/mode"

// ── server functions ──────────────────────────────────────────────────────────

const getBotData = createServerFn({ method: "GET" })
  .inputValidator((data: { botId: string; mode: AppMode }) => data)
  .handler(({ data }) => {
    const decisions = getDecisions(data.botId, data.mode, 50)
    const pnlHistory = getPnlHistory(data.botId, data.mode, 500)
    const summary = getAllBotSummaries([data.botId], data.mode)[0] ?? null
    const raw = readFileSync(join(import.meta.dirname, "../../../bots.json"), "utf8")
    const botsConfig = JSON.parse(raw) as { bots: Array<{ id: string; name: string; description: string; cron: string; model: string; system_prompt: string }> }
    const config = botsConfig.bots.find((b) => b.id === data.botId)
    return { decisions, pnlHistory, summary, config, mode: data.mode }
  })

// ── component ─────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/bots/$botId")({
  validateSearch: (search: Record<string, unknown>) => ({
    mode: normalizeAppMode(search.mode),
  }),
  loaderDeps: ({ search }) => ({ mode: search.mode }),
  component: BotDetail,
  loader: async ({ params, deps }) => getBotData({ data: { botId: params.botId, mode: deps.mode } }),
})

function BotDetail() {
  const navigate = useNavigate({ from: Route.fullPath })
  const { decisions, pnlHistory, summary, config, mode } = Route.useLoaderData()
  const { botId } = Route.useParams()
  const resolvedModel = summary?.runMeta?.model ?? config?.model ?? "None"
  const resolvedHarness = summary?.runMeta?.harness ?? "None"

  const chartData = pnlHistory.map((p: typeof pnlHistory[number]) => ({
    timestamp: p.sim_date ?? p.timestamp,
    returnPct: ((p.portfolio_value - 100_000) / 100_000) * 100,
    spyPct: p.spy_value != null ? ((p.spy_value - 100_000) / 100_000) * 100 : undefined,
  }))

  const latestPnl = pnlHistory[pnlHistory.length - 1]

  return (
    <main className="min-h-screen px-4 pb-10 pt-6 text-gray-100 sm:px-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <Card className="glass-card page-hero-glow mb-6 rounded-[28px]">
          <CardHeader className="flex flex-col gap-5 p-6 sm:flex-row sm:items-start sm:justify-between sm:p-8">
            <div className="max-w-3xl">
              <div className="mb-4 flex items-center gap-3 text-sm">
                <Link to="/" search={{ mode }} className="text-slate-400 transition-colors hover:text-white">
                  ← Back
                </Link>
                <span className="text-slate-600">/</span>
                <Chip className="border border-white/10 bg-white/5 text-slate-300" color="default" variant="soft">
                  {getAppModeLabel(mode)}
                </Chip>
              </div>
              <CardTitle className="text-3xl font-semibold text-white">{config?.name ?? botId}</CardTitle>
              <CardDescription className="mt-3 text-sm leading-6 text-slate-400">
                {getAppModeDescription(mode)} with full return, thesis, and decision visibility for this bot.
              </CardDescription>
              <div className="mt-4 flex flex-wrap gap-2">
                <MetaBadge label="Model" value={resolvedModel} />
                <MetaBadge label="Harness" value={resolvedHarness} />
                {summary?.runMeta?.simStart && summary.runMeta.simEnd && (
                  <MetaBadge label="Run" value={`${summary.runMeta.simStart} -> ${summary.runMeta.simEnd}`} />
                )}
              </div>
            </div>
            <ModeSelect
              value={mode}
              onChange={(nextMode) =>
                navigate({
                  params: { botId },
                  search: { mode: nextMode },
                })
              }
            />
          </CardHeader>
        </Card>

        {/* Stats row */}
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
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
              summary?.totalReturn != null
                ? `${summary.totalReturn.toFixed(2)}%`
                : "—"
            }
            positive={summary?.totalReturn != null ? summary.totalReturn >= 0 : null}
          />
          <StatCard label="Total Decisions" value={(summary?.totalDecisions ?? decisions.length).toString()} />
        </div>

        {/* P&L Chart */}
        <Card className="glass-card mb-6 rounded-[28px]">
          <CardHeader className="p-6 pb-2 sm:p-8 sm:pb-3">
            <CardTitle className="text-base font-semibold text-white">Return vs SPY</CardTitle>
            <CardDescription className="text-xs text-slate-400">% return relative to $100,000 starting capital</CardDescription>
          </CardHeader>
          {chartData.length === 0 ? (
            <CardContent className="flex h-40 items-center justify-center p-6 text-slate-500">No data yet</CardContent>
          ) : (
            <CardContent className="p-4 pt-0 sm:px-6 sm:pb-6">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={chartData}>
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(v) =>
                      mode === "backtesting" ? String(v).slice(0, 10) : new Date(String(v)).toLocaleDateString()
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
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    contentStyle={{ background: "#0d1326", border: "1px solid rgba(148, 163, 184, 0.18)", borderRadius: 16 }}
                    labelFormatter={(v) =>
                      mode === "backtesting" ? String(v).slice(0, 10) : new Date(String(v)).toLocaleString()
                    }
                    formatter={(v) => [typeof v === "number" ? `${v.toFixed(2)}%` : "—"]}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="returnPct"
                    name={config?.name ?? botId}
                    stroke="#7c9cff"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="spyPct"
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

        {/* System prompt / thesis */}
        {config && (
          <details className="glass-card mb-6 overflow-hidden rounded-[28px] group/thesis">
            <summary className="flex items-center justify-between px-6 py-4 cursor-pointer list-none">
              <div>
                <h2 className="text-base font-semibold text-white">Thesis / System Prompt</h2>
                <p className="text-xs text-slate-500 mt-0.5 line-clamp-1 max-w-xl">
                  {config.system_prompt.split("\n\n")[0]}
                </p>
              </div>
              <span className="text-xs text-slate-600 group-open/thesis:rotate-180 transition-transform ml-4 shrink-0">▼</span>
            </summary>
            <div className="px-6 pb-6 border-t border-white/8 pt-4">
              <pre className="text-sm text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                {config.system_prompt}
              </pre>
              <div className="flex gap-4 mt-4 text-xs text-slate-500">
                <span>Model: <span className="text-slate-300">{resolvedModel}</span></span>
                <span>Harness: <span className="text-slate-300">{resolvedHarness}</span></span>
                <span>Cron: <span className="text-slate-300 font-mono">{config.cron}</span></span>
              </div>
            </div>
          </details>
        )}

        {/* Decision log */}
        <Card className="glass-card rounded-[28px]">
          <CardHeader className="p-6 pb-2">
            <CardTitle className="text-base font-semibold text-white">Decision Log</CardTitle>
            <CardDescription className="text-sm text-slate-400">
              Every thesis update, action, and tool call from the selected mode.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-2">
          <div className="space-y-4">
            {decisions.length === 0 && (
              <p className="text-slate-500 text-sm">No decisions yet.</p>
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
                <details key={d.id} className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.03] group">
                  <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.04] transition-colors list-none">
                    <ActionBadge action={d.action} />
                    {d.symbol && (
                      <span className="text-white font-semibold">{d.symbol}</span>
                    )}
                    {d.amount && (
                      <span className="text-slate-400 text-sm">
                        ${d.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </span>
                    )}
                    {errorCalls.length > 0 && (
                      <Chip className="border border-rose-300/10 bg-rose-400/10 text-rose-200" color="default" variant="soft">
                        {errorCalls.length} error{errorCalls.length > 1 ? "s" : ""}
                      </Chip>
                    )}
                    <span className="ml-auto text-xs text-slate-500">{displayDate}</span>
                    <span className="text-xs text-slate-600 group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <div className="px-4 pb-4 border-t border-white/8 pt-3 space-y-3">
                    {d.reasoning && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1">Reasoning</p>
                        <div className="text-sm text-slate-300 leading-relaxed prose prose-sm prose-invert max-w-none
                          [&_ul]:space-y-2 [&_ul]:pl-0 [&_ul]:list-none
                          [&_li]:border-l-2 [&_li]:border-white/10 [&_li]:pl-3
                          [&_strong]:text-slate-100 [&_strong]:font-semibold">
                          <ReactMarkdown>{d.reasoning}</ReactMarkdown>
                        </div>
                      </div>
                    )}
                    {toolCalls.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-2">
                          Tool calls ({toolCalls.length})
                        </p>
                        <div className="space-y-2">
                          {toolCalls.map((tc, i) => {
                            const hasError = isToolError(tc.result)
                            return (
                              <details key={i} className={`rounded-xl overflow-hidden group/tc ${hasError ? "bg-rose-400/8 border border-rose-300/10" : "bg-slate-950/60 border border-white/6"}`}>
                                <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none hover:bg-white/[0.03] transition-colors">
                                  <span className={`text-xs font-mono ${hasError ? "text-rose-300" : "text-blue-300"}`}>{tc.tool}</span>
                                  {hasError && <span className="text-xs text-rose-300">error</span>}
                                  <span className="ml-auto text-xs text-slate-600 group-open/tc:rotate-180 transition-transform">▼</span>
                                </summary>
                                <div className="px-3 pb-3 border-t border-white/6 pt-2">
                                  <p className={`text-xs whitespace-pre-wrap font-mono leading-relaxed ${hasError ? "text-rose-200" : "text-slate-400"}`}>{tc.result}</p>
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
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function MetaBadge({ label, value }: { label: string; value: string }) {
  return (
    <Chip className="border border-white/10 bg-white/5 text-slate-300" color="default" variant="soft">
      {label}: {value}
    </Chip>
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
    <Card className="glass-card-soft rounded-[24px] border-white/8">
      <CardContent className="p-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 mb-1">{label}</p>
      <p
        className={`text-xl font-bold ${
          positive === true
            ? "text-emerald-300"
            : positive === false
              ? "text-rose-300"
              : "text-white"
        }`}
      >
        {value}
      </p>
      </CardContent>
    </Card>
  )
}

function isToolError(result: string): boolean {
  return /^Error|403|401|error \d{3}/i.test(result)
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    buy_stock: "border border-emerald-300/10 bg-emerald-400/10 text-emerald-200",
    sell_stock: "border border-rose-300/10 bg-rose-400/10 text-rose-200",
    do_nothing: "border border-white/10 bg-white/5 text-slate-300",
    error: "border border-amber-300/10 bg-amber-400/10 text-amber-200",
  }
  return (
    <Chip
      className={styles[action] ?? "border border-white/10 bg-white/5 text-slate-300"}
      color="default"
      variant="soft"
    >
      {action.replace("_", " ")}
    </Chip>
  )
}
