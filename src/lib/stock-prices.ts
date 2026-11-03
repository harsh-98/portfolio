// This existing endpoint serves public market quotes and accepts the public API
// key. It does not need a user's session, unlike private portfolio requests.
export async function fetchStockPrices(symbols: string[], signal: AbortSignal) {
  const endpoint = `${String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')}/functions/v1/market-prices`
  // Yahoo's spark endpoint rejects more than 20 symbols. The Edge Function's
  // input limit is larger, so enforce the upstream limit before every request.
  const batches = Array.from({ length: Math.ceil(symbols.length / 20) }, (_, index) => symbols.slice(index * 20, index * 20 + 20))
  const prices = new Map<string, number>()
  let source = 'Stock market feed'
  for (const [index, batch] of batches.entries()) {
    if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, 300))
    signal.throwIfAborted()
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: batch }),
      cache: 'no-store',
      signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = typeof data?.error === 'string' ? ` ${data.error.slice(0, 180)}` : ''
      throw new Error(`Stock quote request failed (HTTP ${response.status}).${detail}`)
    }
    if (!data?.prices || typeof data.prices !== 'object') throw new Error('Stock feed returned no prices.')
    Object.entries(data.prices).forEach(([symbol, raw]) => {
      const price = Number(raw)
      if (Number.isFinite(price) && price > 0) prices.set(symbol.toUpperCase(), price)
    })
    if (typeof data.source === 'string') source = data.source
  }
  if (!prices.size) throw new Error('Stock feed returned no valid prices.')
  return { prices, source }
}
