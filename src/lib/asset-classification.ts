import type { AssetClass } from '../types'

type ClassifiedAsset = { symbol: string; asset_class: AssetClass }

export function effectiveAssetClass(asset: ClassifiedAsset): AssetClass {
  if (['IAU', 'XAUT', 'XAUT0', 'PAXG'].includes(asset.symbol.toUpperCase())) return 'gold'
  return asset.asset_class
}

// Gold-backed IAU is still an exchange-traded fund with stock-market quotes.
export function usesStockQuotes(asset: ClassifiedAsset): boolean {
  return asset.asset_class === 'equity' || asset.symbol.toUpperCase() === 'IAU'
}
