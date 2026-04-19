import type { AppMode } from "../lib/mode"
import { APP_MODES, getAppModeLabel } from "../lib/mode"

export default function ModeSelect({
  value,
  onChange,
  id = "mode-select",
}: {
  value: AppMode
  onChange: (mode: AppMode) => void
  id?: string
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Mode</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as AppMode)}
        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none backdrop-blur-md transition-colors hover:border-white/20 focus:border-blue-400"
      >
        {APP_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {getAppModeLabel(mode)}
          </option>
        ))}
      </select>
    </label>
  )
}
