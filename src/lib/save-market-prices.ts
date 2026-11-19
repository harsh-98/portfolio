import type { SupabaseClient } from '@supabase/supabase-js'
import type { Position } from '../types'

interface Quotes {
  crypto: Map<string, { price: number; source: string; kind: string }>
  stocks: Map<string, number>
  stockSource: string
  fx: { rate: number; date: string } | null
  fetchedAt: string
}

// These tokens have an exchange rate against ETH, so an ETH spot quote alone
// cannot safely revalue the token. Leave their provider valuations intact.
const rateTokens = new Set(['WSTETH', 'RETH', 'WEETH'])

export async function saveMarketPrices(client: SupabaseClient, positions: Position[], ownerId: string, quotes: Quotes) {
  const unavailable = new Set<string>()
  const changes: Array<{ position: Position; price: number; source: string; kind: string }> = []
  for (const position of positions) {
    if (position.owner_id !== ownerId) continue
    const symbol = position.asset.symbol.toUpperCase()
    const assetClass = position.asset.asset_class
    const override = position.metadata.valuation_override as { price_usd?: number } | undefined
    if (typeof override?.price_usd === 'number' && Number.isFinite(override.price_usd) && override.price_usd >= 0) continue
    let price: number | undefined
    let source = '', kind = 'Market quote'
    if (assetClass === 'equity' || symbol === 'IAU') {
      const ticker = symbol === 'GOOG' ? 'GOOGL' : symbol
      price = quotes.stocks.get(ticker)
      source = quotes.stockSource
    } else if (symbol === 'INR' && assetClass === 'cash') {
      price = quotes.fx ? 1 / quotes.fx.rate : undefined
      source = quotes.fx ? `ECB daily reference ${quotes.fx.date}` : ''
      kind = 'Daily reference'
    } else if (['crypto', 'stablecoin'].includes(assetClass) || ['XAUT', 'XAUT0', 'PAXG'].includes(symbol)) {
      if (rateTokens.has(symbol)) { unavailable.add(symbol); continue }
      const ticker = ['WETH', 'STETH', 'EETH'].includes(symbol) ? 'ETH' : ['WBTC', 'UBTC', 'BTCB'].includes(symbol) ? 'BTC' : symbol === 'XAUT' ? 'XAUT0' : symbol
      const quote = quotes.crypto.get(ticker)
      price = quote?.price
      source = quote?.source || ''
      kind = quote?.kind || kind
    } else continue // Cash, options and other manual/provider marks remain intact.
    if (price == null || !Number.isFinite(price) || price <= 0) { unavailable.add(symbol); continue }
    // Match the database's eight-decimal price precision before calculating
    // value, so a later read uses exactly the same price and quantity.
    price = Number(price.toFixed(8))
    if (price <= 0) { unavailable.add(symbol); continue }
    changes.push({ position, price, source, kind })
  }
  let saved = 0, failed = 0
  for (let start = 0; start < changes.length; start += 8) {
    const results = await Promise.allSettled(changes.slice(start, start + 8).map(async ({ position, price, source, kind }) => {
      // Compare updated_at to avoid applying a mark calculated from an obsolete
      // quantity or overwriting metadata changed by a concurrent import.
      const result = await client.from('positions').update({
        price_usd: price,
        value_usd: Math.round(Number(position.quantity) * price * 100) / 100,
        metadata: { ...position.metadata, market_quote: { source, kind, fetched_at: quotes.fetchedAt, saved_at: new Date().toISOString() } },
      }).eq('id', position.id).eq('owner_id', ownerId).eq('updated_at', position.updated_at)
        .select('id').abortSignal(AbortSignal.timeout(15000))
      if (result.error || result.data?.length !== 1) throw new Error('Price could not be saved')
    }))
    saved += results.filter((result) => result.status === 'fulfilled').length
    failed += results.filter((result) => result.status === 'rejected').length
  }
  return { saved, failed, unavailable: [...unavailable].sort() }
}
