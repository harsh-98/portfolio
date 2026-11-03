// This existing endpoint serves public market quotes and accepts the public API
// key. It does not need a user's session, unlike private portfolio requests.
export async function fetchStockPrices(symbols: string[], signal: AbortSignal) {
  const endpoint = `${String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')}/functions/v1/market-prices`
  const batches = Array.from({ length: Math.ceil(symbols.length / 50) }, (_, index) => symbols.slice(index * 50, index * 50 + 50))
  const responses = await Promise.all(batches.map(async (batch) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: batch }),
      cache: 'no-store',
      signal,
    })
    if (!response.ok) throw new Error(`Stock quote request failed (HTTP ${response.status}).`)
    const data = await response.json()
    if (!data?.prices || typeof data.prices !== 'object') throw new Error('Stock feed returned no prices.')
    return data as { prices: Record<string, unknown>; source?: string }
  }))
  const prices = new Map<string, number>()
  for (const response of responses) {
    Object.entries(response.prices).forEach(([symbol, raw]) => {
      const price = Number(raw)
      if (Number.isFinite(price) && price > 0) prices.set(symbol.toUpperCase(), price)
    })
  }
  if (!prices.size) throw new Error('Stock feed returned no valid prices.')
  return { prices, source: responses[0]?.source || 'Stock market feed' }
}
