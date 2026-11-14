interface SpotMetadata {
  tokens: Array<{ index: number; name: string }>
  universe: Array<{ name: string; tokens: number[] }>
}
let spotMetadata: { data: SpotMetadata; fetchedAt: number } | null = null
async function fetchSpotMetadata(signal: AbortSignal): Promise<SpotMetadata> {
  if (spotMetadata && Date.now() - spotMetadata.fetchedAt < 1800000) return spotMetadata.data
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotMeta' }), signal,
  })
  if (!response.ok) throw new Error(`Hyperliquid metadata ${response.status}`)
  const data: SpotMetadata = await response.json()
  if (!Array.isArray(data.tokens) || !Array.isArray(data.universe)) throw new Error('Invalid spot metadata')
  spotMetadata = { data, fetchedAt: Date.now() }
  return data
}

export async function fetchLiveCryptoPrices(signal: AbortSignal = AbortSignal.timeout(12000)) {
  const [binanceResult, hyperliquidResult, metadataResult] = await Promise.allSettled([
    fetch('https://api.binance.com/api/v3/ticker/price', { signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Binance ${response.status}`)
      return response.json() as Promise<Array<{ symbol: string; price: string }>>
    }),
    fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Hyperliquid ${response.status}`)
      return response.json() as Promise<Record<string, string>>
    }),
    fetchSpotMetadata(signal),
  ])
  if (binanceResult.status === 'rejected' && hyperliquidResult.status === 'rejected') throw new Error('Live crypto feeds unavailable')
  const prices = new Map<string, { price: number; source: string; kind: string }>()
  if (binanceResult.status === 'fulfilled') {
    binanceResult.value.forEach(({ symbol, price }) => {
      if (!symbol.endsWith('USDT')) return
      const value = Number(price)
      if (Number.isFinite(value) && value > 0) prices.set(symbol.slice(0, -4), { price: value, source: 'Binance (USDT)', kind: 'Live quote' })
    })
  }
  if (hyperliquidResult.status === 'fulfilled') {
    Object.entries(hyperliquidResult.value).forEach(([symbol, rawPrice]) => {
      const value = Number(rawPrice)
      if (Number.isFinite(value) && value > 0) prices.set(symbol.toUpperCase(), { price: value, source: 'Hyperliquid', kind: 'Live quote' })
    })
  }
  if (!prices.size) throw new Error('Live crypto feeds unavailable')
  if (hyperliquidResult.status === 'fulfilled' && metadataResult.status === 'fulfilled') {
    const metadata = metadataResult.value
    const tokens = new Map(metadata.tokens.map((token) => [token.index, token.name]))
    for (const market of metadata.universe) {
      if (market.tokens[1] !== 0) continue
      const symbol = tokens.get(market.tokens[0])
      const value = Number(hyperliquidResult.value[market.name])
      if (symbol && Number.isFinite(value) && value > 0) prices.set(symbol.toUpperCase(), { price: value, source: 'Hyperliquid spot', kind: 'Live quote' })
    }
  }
  ;['USDT', 'USDC', 'DAI', 'USDE', 'USD1', 'FRAX', 'LUSD', 'GHO'].forEach((symbol) => prices.set(symbol, { price: 1, source: 'USD parity assumption', kind: 'USD peg' }))
  if (!prices.size) throw new Error('Live crypto feeds unavailable')
  return prices
}

