import { Link } from '@tanstack/react-router'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950 px-6 backdrop-blur-lg">
      <nav className="max-w-6xl mx-auto flex items-center gap-4 py-4">
        <Link to="/" className="text-white font-semibold text-sm no-underline hover:text-gray-300 transition-colors">
          Trading Bots
        </Link>
      </nav>
    </header>
  )
}
