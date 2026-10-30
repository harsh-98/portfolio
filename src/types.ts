export type AssetClass = 'cash' | 'stablecoin' | 'equity' | 'crypto' | 'fixed_income' | 'gold' | 'nft' | 'alternative' | 'liability'

export interface Account {
  id: string
  name: string
  institution: string
  account_type: string
  currency: string
  source: string
}

export interface Asset {
  id: string
  symbol: string
  name: string
  asset_class: AssetClass
  currency: string
  network: string | null
}

export interface Position {
  id: string
  account_id: string
  asset_id: string
  quantity: number
  price_usd: number
  value_usd: number
  cost_basis_usd: number | null
  as_of: string
  account: Account
  asset: Asset
}

export interface Snapshot {
  id: string
  snapshot_date: string
  total_value_usd: number
  cash_usd: number
  equities_usd: number
  crypto_usd: number
  alternatives_usd: number
  liabilities_usd: number
}
