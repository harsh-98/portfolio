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
  source_key: string
  as_of: string
  metadata: Record<string, unknown>
  account: Account
  asset: Asset
}

export interface PositionSnapshot {
  id?: string
  snapshot_date: string
  source_key: string
  quantity?: number
  price_usd?: number
  value_usd: number
  account?: Pick<Account, 'name' | 'institution'> | null
  asset?: Pick<Asset, 'symbol' | 'name' | 'asset_class' | 'network'> | null
}

export interface SyncRun {
  id: string
  source: string
  status: 'running' | 'success' | 'partial' | 'failed'
  records_written: number
  message: string | null
  started_at: string
  finished_at: string | null
}

export interface BrokerageTransaction {
  id: string
  event_time: string
  event_type: string
  quantity: number | null
  price_usd: number | null
  amount_usd: number | null
  realized_pnl_usd: number | null
  account: Pick<Account, 'name' | 'institution'> | null
  asset: Pick<Asset, 'symbol' | 'name'> | null
}

export interface SpendTransaction {
  id: string
  source: string
  occurred_at: string
  merchant: string | null
  description: string | null
  amount_usd: number
  category: string | null
  status: string | null
  transaction_type: string
}

export interface LossEvent {
  id: string
  event_key: string
  event_at: string | null
  date_precision: 'exact' | 'month' | 'valuation_date' | 'unknown'
  title: string
  category: string
  status: 'realized' | 'unrealized' | 'mixed' | 'pending'
  loss_low_usd: number | null
  loss_high_usd: number | null
  details: string
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
