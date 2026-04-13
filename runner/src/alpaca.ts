/**
 * Thin Alpaca REST client.
 *
 * Credentials are passed as env var *names* so each bot can point at its own
 * Alpaca paper-trading account. The MCP server reads the generic ALPACA_KEY /
 * ALPACA_SECRET / ALPACA_ENDPOINT vars that bot-runner injects per-run.
 */

export interface AlpacaConfig {
  key: string
  secret: string
  /** Base URL without trailing /v2, e.g. https://paper-api.alpaca.markets */
  endpoint: string
}

/**
 * Build an AlpacaConfig from env var names.
 *
 * @param keyEnv     Name of the env var holding the API key     (default: "ALPACA_KEY")
 * @param secretEnv  Name of the env var holding the API secret  (default: "ALPACA_SECRET")
 * @param endpointEnv Name of the env var holding the endpoint   (default: "ALPACA_ENDPOINT")
 */
export function getAlpacaConfig(
  keyEnv = "ALPACA_KEY",
  secretEnv = "ALPACA_SECRET",
  endpointEnv = "ALPACA_ENDPOINT",
): AlpacaConfig {
  const key = process.env[keyEnv]
  const secret = process.env[secretEnv]
  const endpoint = process.env[endpointEnv] ?? "https://paper-api.alpaca.markets"

  if (!key || !secret) {
    throw new Error(`Missing Alpaca credentials: ${keyEnv} / ${secretEnv} not set in environment`)
  }

  // Strip trailing /v2 if present — we add it per-call
  return { key, secret, endpoint: endpoint.replace(/\/v2$/, "") }
}

async function alpacaFetch(
  config: AlpacaConfig,
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = `${config.endpoint}/v2${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      "APCA-API-KEY-ID": config.key,
      "APCA-API-SECRET-KEY": config.secret,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Alpaca API error ${res.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

export interface AlpacaAccount {
  portfolio_value: string
  cash: string
  equity: string
  buying_power: string
}

export interface AlpacaPosition {
  symbol: string
  qty: string
  avg_entry_price: string
  current_price: string
  unrealized_pl: string
  unrealized_plpc: string
  market_value: string
}

export async function getAccount(config: AlpacaConfig): Promise<AlpacaAccount> {
  return alpacaFetch(config, "/account") as Promise<AlpacaAccount>
}

export async function getPositions(config: AlpacaConfig): Promise<AlpacaPosition[]> {
  return alpacaFetch(config, "/positions") as Promise<AlpacaPosition[]>
}

export async function submitOrder(
  config: AlpacaConfig,
  params: {
    symbol: string
    notional?: number
    qty?: number
    side: "buy" | "sell"
    type?: "market" | "limit"
    time_in_force?: "day" | "gtc" | "ioc" | "fok"
  },
): Promise<unknown> {
  return alpacaFetch(config, "/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: params.symbol,
      notional: params.notional,
      qty: params.qty,
      side: params.side,
      type: params.type ?? "market",
      time_in_force: params.time_in_force ?? "day",
    }),
  })
}

export async function closePosition(config: AlpacaConfig, symbol: string): Promise<unknown> {
  return alpacaFetch(config, `/positions/${symbol}`, { method: "DELETE" })
}

export async function getOrders(
  config: AlpacaConfig,
  status = "all",
  limit = 10,
): Promise<unknown> {
  return alpacaFetch(config, `/orders?status=${status}&limit=${limit}`)
}
