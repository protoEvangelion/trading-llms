import { Link } from '@tanstack/react-router'
import { LineChart } from 'lucide-react'
import { DEFAULT_APP_MODE } from '../lib/mode'
import ThemeToggle from './ThemeToggle'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 px-4 pt-4 sm:px-6">
      <nav className="glass-card mx-auto flex max-w-7xl items-center justify-between rounded-2xl px-4 py-3 sm:px-5">
        <Link
          to="/"
          search={(prev) => ({ mode: prev.mode ?? DEFAULT_APP_MODE })}
          className="flex items-center gap-3 text-sm font-semibold text-white no-underline transition-colors hover:text-blue-100"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/20 via-cyan-400/10 to-emerald-400/10 text-blue-200 ring-1 ring-white/10">
            <LineChart className="h-4 w-4" />
          </span>
          <span className="flex flex-col">
            <span className="text-sm font-semibold text-white">Trading Bots</span>
            <span className="text-xs font-medium text-slate-400">Thesis-driven observability</span>
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
        </div>
      </nav>
    </header>
  )
}
