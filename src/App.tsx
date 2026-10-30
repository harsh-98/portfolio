import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Coins,
  Layers3,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { isConfigured, supabase } from './lib/supabase'
import type { Account, AssetClass, BrokerageTransaction, Position, PositionSnapshot, Snapshot, SpendTransaction, SyncRun } from './types'

ModuleRegistry.registerModules([AllCommunityModule])

const portfolioGridTheme = themeQuartz.withParams({
  accentColor: '#68d3a0',
  backgroundColor: '#0d1216',
  borderColor: '#242c33',
  browserColorScheme: 'dark',
  foregroundColor: '#cbd3d7',
  headerBackgroundColor: '#11171c',
  headerTextColor: '#78858d',
  oddRowBackgroundColor: '#0f1418',
  rowHoverColor: '#151c21',
  fontFamily: 'Manrope, sans-serif',
  fontSize: 10,
})

type HoldingGridRow = {
  id: string
  asset: string
  name: string
  account: string
  institution: string
  assetClass: string
  quantity: number
  price: number
  value: number
  pnl: number | null
  weight: number
}

type TransactionGridRow = {
  id: string
  eventTime: Date
  eventType: string
  asset: string
  quantity: number | null
  price: number | null
  amount: number | null
  realizedPnl: number | null
}

const classMeta: Record<AssetClass, { label: string; color: string }> = {
  cash: { label: 'Cash', color: '#2f7d64' },
  stablecoin: { label: 'Stablecoins', color: '#75a58c' },
  equity: { label: 'Equities', color: '#c77a43' },
  crypto: { label: 'Crypto', color: '#7567a8' },
  fixed_income: { label: 'Fixed income', color: '#5c86a6' },
  gold: { label: 'Gold', color: '#bc9a47' },
  nft: { label: 'NFTs', color: '#a06072' },
  alternative: { label: 'Alternatives', color: '#75806f' },
  liability: { label: 'Liabilities', color: '#9b4b43' },
}

type View = 'overview' | 'crypto' | 'holdings' | 'activity'

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function formatMoney(value: number) {
  return money.format(Number.isFinite(value) ? value : 0)
}

function formatAmount(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)
}

function canonicalCryptoSymbol(symbol: string) {
  const normalized = symbol.toUpperCase()
  if (['WBTC', 'UBTC', 'BTCB'].includes(normalized)) return 'BTC'
  if (['WETH', 'STETH', 'WSTETH', 'RETH', 'WEETH', 'EETH'].includes(normalized)) return 'ETH'
  if (['XAUT0', 'XAUT'].includes(normalized)) return 'XAUT'
  return normalized
}

function effectiveAssetClass(asset: { symbol: string; asset_class: AssetClass }) {
  if (['XAUT', 'XAUT0', 'PAXG'].includes(asset.symbol.toUpperCase())) return 'gold' as AssetClass
  return asset.asset_class
}

function isDigitalAsset(asset: { symbol: string; asset_class: AssetClass }) {
  return ['crypto', 'stablecoin', 'nft'].includes(asset.asset_class) || ['XAUT', 'XAUT0', 'PAXG'].includes(asset.symbol.toUpperCase())
}

function canonicalEquitySymbol(symbol: string) {
  const normalized = symbol.toUpperCase()
  if (normalized === 'GOOG') return 'GOOGL'
  return normalized
}

function shortAddress(value: string) {
  const match = value.match(/0x[a-fA-F0-9]{10,}/)
  return match ? `${match[0].slice(0, 6)}…${match[0].slice(-4)}` : null
}

function platformIdentity(account: Pick<Account, 'name' | 'institution'>, sourceKey = '') {
  const identity = `${account.name} ${account.institution} ${sourceKey}`
  const address = shortAddress(identity)
  if (address) return address
  if (/rabby|hyperliquid/i.test(identity)) return account.name.split(' · ')[0].replace(/^Hyperliquid\s*[·:-]?\s*/i, '') || 'Self-custody'
  if (/schwab|charles/i.test(identity)) return 'Charles Schwab'
  if (/wio/i.test(identity)) return 'Wio'
  if (/xtb/i.test(identity)) return 'XTB'
  if (/binance/i.test(identity)) return 'Binance'
  if (/india|inr/i.test(identity)) return 'India cash'
  if (/ether\.fi|etherfi|gbp/i.test(identity)) return 'Ether.fi UK'
  if (/kast/i.test(identity)) return 'KAST'
  return account.institution || account.name
}

function positionPlatform(position: Position) {
  return platformIdentity(position.account, position.source_key)
}

function Login() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setStatus('sending')
    setMessage('')
    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}`
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    })
    if (error) {
      setStatus('error')
      setMessage(error.message)
      return
    }
    setStatus('sent')
    setMessage('Check your email for a secure sign-in link.')
  }

  return (
    <main className="login-shell">
      <section className="login-story">
        <div className="brand-mark"><Sparkles size={18} /> Northstar</div>
        <div className="story-copy">
          <p className="eyebrow">PRIVATE WEALTH OVERVIEW</p>
          <h1>Every account.<br />One clear direction.</h1>
          <p>Track traditional assets, digital assets and cash across every platform without losing sight of the whole.</p>
        </div>
        <div className="trust-line"><ShieldCheck size={18} /> Protected by account-level access policies</div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">WELCOME BACK</p>
          <h2>Open your portfolio</h2>
          <p className="muted">Enter your approved email. We’ll send a one-time sign-in link—no password required.</p>
          <form onSubmit={submit}>
            <label htmlFor="email">Email address</label>
            <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
            <button className="primary-button" type="submit" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Send secure link'}
            </button>
          </form>
          {message && <div className={`form-message ${status}`}>{message}</div>}
          <p className="fine-print">Financial data is available only after authentication. The public site contains no portfolio records.</p>
        </div>
      </section>
    </main>
  )
}

function ConfigurationNotice() {
  return (
    <main className="configuration-shell">
      <div className="configuration-card">
        <div className="icon-tile"><ShieldCheck size={24} /></div>
        <p className="eyebrow">CONFIGURATION REQUIRED</p>
        <h1>Connect the private data layer</h1>
        <p>This build is healthy, but the Supabase project URL and publishable key have not been supplied to the deployment environment.</p>
        <code>VITE_SUPABASE_URL<br />VITE_SUPABASE_PUBLISHABLE_KEY</code>
      </div>
    </main>
  )
}

interface HoldingFormProps {
  accounts: Account[]
  onClose: () => void
  onSaved: () => Promise<void>
}

function HoldingForm({ accounts, onClose, onSaved }: HoldingFormProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id || '')
  const [newAccount, setNewAccount] = useState('')
  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')
  const [assetClass, setAssetClass] = useState<AssetClass>('cash')
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('1')
  const [costBasis, setCostBasis] = useState('')

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const { data: auth } = await supabase.auth.getUser()
    const ownerId = auth.user?.id
    if (!ownerId) {
      setError('Your session has expired. Please sign in again.')
      setBusy(false)
      return
    }

    let selectedAccountId = accountId
    if (!selectedAccountId && newAccount.trim()) {
      const { data, error: accountError } = await supabase
        .from('accounts')
        .insert({
          owner_id: ownerId,
          name: newAccount.trim(),
          institution: newAccount.trim(),
          account_type: 'manual',
          currency: 'USD',
          source: 'manual',
        })
        .select('id')
        .single()
      if (accountError) {
        setError(accountError.message)
        setBusy(false)
        return
      }
      selectedAccountId = data.id
    }

    if (!selectedAccountId) {
      setError('Choose an account or create a new one.')
      setBusy(false)
      return
    }

    const normalizedSymbol = symbol.trim().toUpperCase()
    const { data: existingAsset } = await supabase
      .from('assets')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('symbol', normalizedSymbol)
      .is('network', null)
      .maybeSingle()

    let assetId = existingAsset?.id
    if (!assetId) {
      const { data, error: assetError } = await supabase
        .from('assets')
        .insert({
          owner_id: ownerId,
          symbol: normalizedSymbol,
          name: name.trim() || normalizedSymbol,
          asset_class: assetClass,
          currency: 'USD',
        })
        .select('id')
        .single()
      if (assetError) {
        setError(assetError.message)
        setBusy(false)
        return
      }
      assetId = data.id
    }

    const quantityNumber = Number(quantity)
    const priceNumber = Number(price)
    const { error: positionError } = await supabase.from('positions').insert({
      owner_id: ownerId,
      account_id: selectedAccountId,
      asset_id: assetId,
      quantity: quantityNumber,
      price_usd: priceNumber,
      value_usd: quantityNumber * priceNumber,
      cost_basis_usd: costBasis ? Number(costBasis) : null,
      source_key: `manual:${selectedAccountId}:${assetId}:${Date.now()}`,
      as_of: new Date().toISOString(),
    })
    if (positionError) {
      setError(positionError.message)
      setBusy(false)
      return
    }
    await onSaved()
    onClose()
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-holding-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">MANUAL POSITION</p><h2 id="add-holding-title">Add a holding</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        </div>
        <form className="holding-form" onSubmit={save}>
          <label>Account
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">Create a new account</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </label>
          {!accountId && <label>New account name<input value={newAccount} onChange={(event) => setNewAccount(event.target.value)} placeholder="e.g. Wio Cash" required /></label>}
          <div className="form-grid">
            <label>Symbol<input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="USD" required /></label>
            <label>Asset class
              <select value={assetClass} onChange={(event) => setAssetClass(event.target.value as AssetClass)}>
                {Object.entries(classMeta).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
              </select>
            </label>
          </div>
          <label>Asset name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="US Dollar" /></label>
          <div className="form-grid">
            <label>Quantity<input type="number" step="any" min="0" value={quantity} onChange={(event) => setQuantity(event.target.value)} required /></label>
            <label>Price in USD<input type="number" step="any" min="0" value={price} onChange={(event) => setPrice(event.target.value)} required /></label>
          </div>
          <label>Total cost basis (optional)<input type="number" step="any" min="0" value={costBasis} onChange={(event) => setCostBasis(event.target.value)} /></label>
          {error && <div className="form-message error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button compact" disabled={busy}>{busy ? 'Saving…' : 'Save holding'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function Dashboard({ session }: { session: Session }) {
  const [view, setView] = useState<View>('overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [positions, setPositions] = useState<Position[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [positionSnapshots, setPositionSnapshots] = useState<PositionSnapshot[]>([])
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([])
  const [brokerageTransactions, setBrokerageTransactions] = useState<BrokerageTransaction[]>([])
  const [spendTransactions, setSpendTransactions] = useState<SpendTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showHoldingForm, setShowHoldingForm] = useState(false)
  const [expandedDigital, setExpandedDigital] = useState<string | null>(null)
  const [expandedEquity, setExpandedEquity] = useState<string | null>(null)
  const [selectedAllocation, setSelectedAllocation] = useState<AssetClass | null>(null)
  const [selectedBrokerDetail, setSelectedBrokerDetail] = useState<{ symbol: string; venue: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [positionsResult, accountsResult, snapshotsResult, positionSnapshotsResult, syncRunsResult, brokerageResult, spendResult] = await Promise.all([
      supabase.from('positions').select('*, account:accounts(*), asset:assets(*)').order('value_usd', { ascending: false }),
      supabase.from('accounts').select('*').order('name'),
      supabase.from('portfolio_snapshots').select('*').order('snapshot_date', { ascending: true }).limit(90),
      supabase.from('position_snapshots').select('snapshot_date,source_key,quantity,price_usd,value_usd,account:accounts(name,institution),asset:assets(symbol,name,asset_class,network)').order('snapshot_date', { ascending: true }).limit(10000),
      supabase.from('sync_runs').select('id,source,status,records_written,message,started_at,finished_at').order('started_at', { ascending: false }).limit(20),
      supabase.from('brokerage_transactions').select('id,event_time,event_type,quantity,price_usd,amount_usd,realized_pnl_usd,account:accounts(name,institution),asset:assets(symbol,name)').order('event_time', { ascending: false }).limit(1000),
      supabase.from('spend_transactions').select('id,source,occurred_at,merchant,description,amount_usd,category,status').order('occurred_at', { ascending: false }).limit(1000),
    ])
    const failure = positionsResult.error || accountsResult.error || snapshotsResult.error || positionSnapshotsResult.error || syncRunsResult.error || brokerageResult.error || spendResult.error
    if (failure) setError(failure.message)
    setPositions((positionsResult.data || []) as unknown as Position[])
    setAccounts((accountsResult.data || []) as Account[])
    setSnapshots((snapshotsResult.data || []) as Snapshot[])
    setPositionSnapshots((positionSnapshotsResult.data || []) as unknown as PositionSnapshot[])
    setSyncRuns((syncRunsResult.data || []) as SyncRun[])
    setBrokerageTransactions((brokerageResult.data || []) as unknown as BrokerageTransaction[])
    setSpendTransactions((spendResult.data || []) as SpendTransaction[])
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const total = useMemo(() => positions.reduce((sum, position) => sum + Number(position.value_usd), 0), [positions])
  const allocation = useMemo(() => {
    const grouped = new Map<string, number>()
    positions.forEach((position) => {
      const assetClass = effectiveAssetClass(position.asset)
      grouped.set(assetClass, (grouped.get(assetClass) || 0) + Number(position.value_usd))
    })
    return Object.entries(classMeta)
      .map(([key, meta]) => ({ key, ...meta, value: grouped.get(key) || 0 }))
      .filter((item) => item.value > 0)
  }, [positions])
  const liquid = allocation.filter((item) => ['cash', 'stablecoin'].includes(item.key)).reduce((sum, item) => sum + item.value, 0)
  const allocationArcs = allocation.map((item, index) => ({
    ...item,
    percent: total ? (item.value / total) * 100 : 0,
    offset: -(total ? (allocation.slice(0, index).reduce((sum, entry) => sum + entry.value, 0) / total) * 100 : 0),
  }))
  const equities = allocation.find((item) => item.key === 'equity')?.value || 0
  const crypto = allocation.filter((item) => ['crypto', 'nft'].includes(item.key)).reduce((sum, item) => sum + item.value, 0)
  const allocationBreakdowns = useMemo(() => {
    const classes = new Map<AssetClass, Map<string, number>>()
    positions.forEach((position) => {
      const assetClass = effectiveAssetClass(position.asset)
      const platforms = classes.get(assetClass) || new Map<string, number>()
      const platform = positionPlatform(position)
      platforms.set(platform, (platforms.get(platform) || 0) + Number(position.value_usd))
      classes.set(assetClass, platforms)
    })
    return classes
  }, [positions])
  const selectedAllocationItem = allocation.find((item) => item.key === selectedAllocation)
  const selectedAllocationPlatforms = selectedAllocation
    ? [...(allocationBreakdowns.get(selectedAllocation)?.entries() || [])].sort((a, b) => b[1] - a[1])
    : []
  const platformTotals = useMemo(() => {
    const grouped = new Map<string, number>()
    positions.forEach((position) => {
      const platform = positionPlatform(position)
      grouped.set(platform, (grouped.get(platform) || 0) + Number(position.value_usd))
    })
    return [...grouped.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [positions])
  const equityPositions = positions.filter((position) => position.asset.asset_class === 'equity')
  const cryptoExposure = useMemo(() => {
    const grouped = new Map<string, { symbol: string; name: string; value: number; quantity: number; pricedCost: number; pricedValue: number; pricedQuantity: number; breakdown: Map<string, { value: number; quantity: number; costBasis: number; pricedValue: number; pricedQuantity: number }> }>()
    positions.filter((position) => ['crypto', 'stablecoin'].includes(effectiveAssetClass(position.asset))).forEach((position) => {
      const symbol = canonicalCryptoSymbol(position.asset.symbol)
      const current = grouped.get(symbol) || { symbol, name: position.asset.name, value: 0, quantity: 0, pricedCost: 0, pricedValue: 0, pricedQuantity: 0, breakdown: new Map<string, { value: number; quantity: number; costBasis: number; pricedValue: number; pricedQuantity: number }>() }
      const value = Number(position.value_usd)
      const quantity = Number(position.quantity)
      const costBasis = position.cost_basis_usd == null ? 0 : Number(position.cost_basis_usd)
      current.value += value
      current.quantity += quantity
      if (position.cost_basis_usd != null) {
        current.pricedCost += costBasis
        current.pricedValue += value
        current.pricedQuantity += quantity
      }
      const platform = positionPlatform(position)
      const detail = current.breakdown.get(platform) || { value: 0, quantity: 0, costBasis: 0, pricedValue: 0, pricedQuantity: 0 }
      detail.value += value
      detail.quantity += quantity
      if (position.cost_basis_usd != null) {
        detail.costBasis += costBasis
        detail.pricedValue += value
        detail.pricedQuantity += quantity
      }
      current.breakdown.set(platform, detail)
      grouped.set(symbol, current)
    })
    return [...grouped.values()].filter((item) => item.value >= 100).sort((a, b) => b.value - a.value)
  }, [positions])
  const equityExposure = useMemo(() => {
    const grouped = new Map<string, { symbol: string; name: string; value: number; quantity: number; costBasis: number; pricedCost: number; pricedValue: number; pricedQuantity: number; breakdown: Map<string, { value: number; quantity: number; costBasis: number }> }>()
    equityPositions.forEach((position) => {
      const symbol = canonicalEquitySymbol(position.asset.symbol)
      const current = grouped.get(symbol) || { symbol, name: symbol === 'GOOGL' ? 'Alphabet' : position.asset.name, value: 0, quantity: 0, costBasis: 0, pricedCost: 0, pricedValue: 0, pricedQuantity: 0, breakdown: new Map<string, { value: number; quantity: number; costBasis: number }>() }
      const value = Number(position.value_usd)
      const quantity = Number(position.quantity)
      const costBasis = position.cost_basis_usd == null ? 0 : Number(position.cost_basis_usd)
      current.value += value
      current.quantity += quantity
      current.costBasis += costBasis
      if (position.cost_basis_usd != null) {
        current.pricedCost += costBasis
        current.pricedValue += value
        current.pricedQuantity += quantity
      }
      const venue = positionPlatform(position)
      const detail = current.breakdown.get(venue) || { value: 0, quantity: 0, costBasis: 0 }
      detail.value += value
      detail.quantity += quantity
      detail.costBasis += costBasis
      current.breakdown.set(venue, detail)
      grouped.set(symbol, current)
    })
    return [...grouped.values()].sort((a, b) => b.value - a.value)
  }, [equityPositions])
  const stockCostBasis = equityExposure.reduce((sum, asset) => sum + asset.pricedCost, 0)
  const stockPnl = equityExposure.reduce((sum, asset) => sum + asset.pricedValue - asset.pricedCost, 0)
  const brokerageByAsset = useMemo(() => {
    const grouped = new Map<string, BrokerageTransaction[]>()
    brokerageTransactions.forEach((transaction) => {
      if (!transaction.asset?.symbol) return
      const symbol = canonicalEquitySymbol(transaction.asset.symbol)
      grouped.set(symbol, [...(grouped.get(symbol) || []), transaction])
    })
    return grouped
  }, [brokerageTransactions])
  const selectedBrokerTransactions = selectedBrokerDetail
    ? (brokerageByAsset.get(selectedBrokerDetail.symbol) || []).filter((transaction) => transaction.account && platformIdentity(transaction.account) === selectedBrokerDetail.venue)
    : []
  const transactionGridRows = useMemo<TransactionGridRow[]>(() => selectedBrokerTransactions.map((transaction) => ({
    id: transaction.id,
    eventTime: new Date(transaction.event_time),
    eventType: transaction.event_type,
    asset: transaction.asset?.name || transaction.asset?.symbol || selectedBrokerDetail?.symbol || '',
    quantity: transaction.quantity == null ? null : Number(transaction.quantity),
    price: transaction.price_usd == null ? null : Number(transaction.price_usd),
    amount: transaction.amount_usd == null ? null : Number(transaction.amount_usd),
    realizedPnl: transaction.realized_pnl_usd == null ? null : Number(transaction.realized_pnl_usd),
  })), [selectedBrokerDetail, selectedBrokerTransactions])
  const transactionColumns = useMemo<ColDef<TransactionGridRow>[]>(() => [
    { field: 'eventTime', headerName: 'Date', minWidth: 105, sort: 'desc', filter: 'agDateColumnFilter', valueFormatter: ({ value }) => value instanceof Date ? value.toLocaleDateString() : '—' },
    { field: 'eventType', headerName: 'Transaction', minWidth: 125, filter: 'agTextColumnFilter' },
    { field: 'asset', headerName: 'Asset', minWidth: 150, flex: 1, filter: 'agTextColumnFilter' },
    { field: 'quantity', headerName: 'Quantity', minWidth: 105, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : formatAmount(Number(value)) },
    { field: 'price', headerName: 'Price', minWidth: 100, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : formatMoney(Number(value)) },
    { field: 'amount', headerName: 'Amount', minWidth: 105, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : formatMoney(Number(value)) },
    { field: 'realizedPnl', headerName: 'Realized P/L', minWidth: 115, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${formatMoney(Number(value))}`, cellClass: ({ value }) => value == null ? '' : Number(value) >= 0 ? 'grid-pnl-positive' : 'grid-pnl-negative' },
  ], [])
  const cryptoHistory = useMemo(() => {
    const grouped = new Map<string, { date: string; total: number; platforms: Map<string, number> }>()
    positionSnapshots.forEach((snapshot) => {
      if (!snapshot.asset || !snapshot.account || !isDigitalAsset(snapshot.asset)) return
      const current = grouped.get(snapshot.snapshot_date) || { date: snapshot.snapshot_date, total: 0, platforms: new Map<string, number>() }
      const value = Number(snapshot.value_usd)
      const platform = platformIdentity(snapshot.account, snapshot.source_key)
      current.total += value
      current.platforms.set(platform, (current.platforms.get(platform) || 0) + value)
      grouped.set(snapshot.snapshot_date, current)
    })
    return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [positionSnapshots])
  const currentDigitalValue = positions.filter((position) => isDigitalAsset(position.asset)).reduce((sum, position) => sum + Number(position.value_usd), 0)
  const firstCryptoPoint = cryptoHistory[0]
  const latestCryptoPoint = cryptoHistory[cryptoHistory.length - 1]
  const priorCryptoPoint = cryptoHistory[cryptoHistory.length - 2]
  const cryptoWeeklyChange = latestCryptoPoint && priorCryptoPoint ? latestCryptoPoint.total - priorCryptoPoint.total : 0
  const cryptoSinceStart = latestCryptoPoint && firstCryptoPoint ? latestCryptoPoint.total - firstCryptoPoint.total : 0
  const cryptoChartMin = cryptoHistory.length ? Math.min(...cryptoHistory.map((point) => point.total)) : 0
  const cryptoChartMax = cryptoHistory.length ? Math.max(...cryptoHistory.map((point) => point.total)) : 0
  const cryptoChartPoints = cryptoHistory.map((point, index) => {
    const x = cryptoHistory.length === 1 ? 500 : (index / (cryptoHistory.length - 1)) * 1000
    const range = cryptoChartMax - cryptoChartMin || 1
    const y = 270 - ((point.total - cryptoChartMin) / range) * 230
    return `${x},${y}`
  }).join(' ')
  const cryptoPlatformRows = latestCryptoPoint
    ? [...latestCryptoPoint.platforms.entries()].map(([platform, value]) => ({ platform, value, start: firstCryptoPoint?.platforms.get(platform) || 0 })).sort((a, b) => b.value - a.value)
    : []
  const realizedXtb = brokerageTransactions.reduce((sum, transaction) => sum + Number(transaction.realized_pnl_usd || 0), 0)
  const recentSpend = spendTransactions.filter((transaction) => new Date(transaction.occurred_at).getTime() >= Date.now() - 30 * 86_400_000)
  const recentSpendTotal = recentSpend.reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount_usd)), 0)
  const spendBySource = [...recentSpend.reduce((grouped, transaction) => grouped.set(transaction.source, (grouped.get(transaction.source) || 0) + Math.abs(Number(transaction.amount_usd))), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])
  const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null
  const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2].total_value_usd : null
  const change = previous ? total - previous : 0
  const changePercent = previous ? (change / previous) * 100 : 0
  const snapshotMessage = previous
    ? `${formatMoney(Math.abs(change))} (${Math.abs(changePercent).toFixed(2)}%) since prior snapshot`
    : latestSnapshot
      ? `Baseline captured ${new Date(`${latestSnapshot.snapshot_date}T00:00:00`).toLocaleDateString([], { dateStyle: 'medium' })}`
      : 'No snapshot captured yet'
  const filteredPositions = positions.filter((position) => {
    const query = search.toLowerCase()
    return [position.asset.symbol, position.asset.name, position.account.name, position.account.institution].some((value) => value.toLowerCase().includes(query))
  })
  const holdingGridRows = useMemo<HoldingGridRow[]>(() => positions.map((position) => {
    const value = Number(position.value_usd)
    const costBasis = position.cost_basis_usd == null ? null : Number(position.cost_basis_usd)
    return {
      id: position.id,
      asset: position.asset.symbol,
      name: position.asset.name,
      account: position.account.name,
      institution: position.account.institution,
      assetClass: classMeta[position.asset.asset_class].label,
      quantity: Number(position.quantity),
      price: Number(position.price_usd),
      value,
      pnl: costBasis == null ? null : value - costBasis,
      weight: total ? (value / total) * 100 : 0,
    }
  }), [positions, total])
  const holdingColumns = useMemo<ColDef<HoldingGridRow>[]>(() => [
    { field: 'asset', headerName: 'Asset', minWidth: 110, pinned: 'left', filter: 'agTextColumnFilter', cellRenderer: ({ data }: { data?: HoldingGridRow }) => data ? <span className="grid-asset"><strong>{data.asset}</strong><small>{data.name}</small></span> : null },
    { field: 'account', headerName: 'Account', minWidth: 170, flex: 1, filter: 'agTextColumnFilter', cellRenderer: ({ data }: { data?: HoldingGridRow }) => data ? <span className="grid-asset"><strong>{data.account}</strong><small>{data.institution}</small></span> : null },
    { field: 'assetClass', headerName: 'Class', minWidth: 120, filter: 'agTextColumnFilter' },
    { field: 'quantity', headerName: 'Quantity', minWidth: 115, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => formatAmount(Number(value)) },
    { field: 'price', headerName: 'Price', minWidth: 105, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => formatMoney(Number(value)) },
    { field: 'value', headerName: 'Value', minWidth: 115, sort: 'desc', filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => formatMoney(Number(value)) },
    { field: 'pnl', headerName: 'P/L', minWidth: 115, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${formatMoney(Number(value))}`, cellClass: ({ value }) => value == null ? '' : Number(value) >= 0 ? 'grid-pnl-positive' : 'grid-pnl-negative' },
    { field: 'weight', headerName: 'Weight', minWidth: 100, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => `${Number(value).toFixed(2)}%` },
  ], [])

  const navItems: Array<{ id: View; label: string; icon: typeof BarChart3 }> = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'crypto', label: 'Crypto value', icon: Coins },
    { id: 'holdings', label: 'Holdings', icon: Layers3 },
    { id: 'activity', label: 'Activity', icon: Activity },
  ]

  function chooseView(next: View) {
    setView(next)
    setMobileNav(false)
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="sidebar-brand"><button className="brand-button" onClick={() => chooseView('overview')}><span><Sparkles size={17} /></span><strong>Northstar</strong></button><button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={19} /></button></div>
        <nav>
          <p>PORTFOLIO</p>
          {navItems.map((item) => {
            const Icon = item.icon
            return <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => chooseView(item.id)}><Icon size={18} />{item.label}</button>
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-card"><ShieldCheck size={20} /><div><strong>Private by design</strong><span>Row-level access active</span></div></div>
          <button className="sign-out" onClick={() => supabase.auth.signOut()}><LogOut size={17} />Sign out</button>
        </div>
      </aside>
      {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}

      <main className="dashboard-main">
        <header className="topbar">
          <div className="topbar-left"><button className="menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={21} /></button><button className="topbar-brand" onClick={() => chooseView('overview')}><Sparkles size={16} />Northstar</button></div>
          <div className="workspace-status"><span className="status-dot" />Private shared workspace</div>
          <div className="profile-wrap"><button className="profile-button" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen}><span>{session.user.email?.slice(0, 1).toUpperCase()}</span><ChevronDown size={15} /></button>{profileOpen && <div className="profile-menu"><strong>{session.user.email}</strong><small>Approved portfolio access</small><button onClick={() => supabase.auth.signOut()}><LogOut size={15} />Sign out</button></div>}</div>
        </header>

        <div className={`page-content ${view === 'overview' ? 'overview-page' : ''}`}>
          {view !== 'overview' && <div className="page-heading">
            <div><p className="eyebrow">{view.toUpperCase()}</p><h1>{view === 'crypto' ? 'Crypto value history' : view === 'holdings' ? 'All holdings' : 'Portfolio activity'}</h1></div>
            <div className="heading-actions"><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spinning' : ''} />Refresh</button><button className="primary-button compact" onClick={() => setShowHoldingForm(true)}><Plus size={17} />Add holding</button></div>
          </div>}

          {error && <div className="error-banner"><ShieldCheck size={18} /><span>{error}</span></div>}

          {view === 'overview' && (
            <section className="overview-dashboard">
              <div className="overview-kpis">
                <article className="net-worth-card"><span>Net worth</span><strong>{loading ? '—' : formatMoney(total)}</strong><p className={previous && change < 0 ? 'negative' : 'positive'}>{previous ? (change >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />) : <ShieldCheck size={13} />}{snapshotMessage}</p></article>
                <article className="summary-cell"><span>Cash available</span><strong>{formatMoney(liquid)}</strong><small>{total ? `${((liquid / total) * 100).toFixed(1)}% of net worth` : '—'}</small></article>
                <article className="summary-cell"><span>Invested</span><strong>{formatMoney(total - liquid)}</strong><small>{total ? `${(((total - liquid) / total) * 100).toFixed(1)}% of net worth` : '—'}</small></article>
              </div>

              <div className="overview-grid">
                <article className="panel overview-platforms">
                  <div className="panel-heading"><div><p className="eyebrow">BY PLATFORM / ADDRESS</p><h2>Portfolio network</h2></div><span>{platformTotals.length}</span></div>
                  <div className="platform-list">{platformTotals.map((source) => <div key={source.name}><span><strong>{source.name}</strong><small>{total ? ((source.value / total) * 100).toFixed(1) : '0.0'}%</small></span><b>{formatMoney(source.value)}</b></div>)}</div>
                </article>

                <article className="panel overview-allocation">
                  <div className="panel-heading"><div><p className="eyebrow">ASSET ALLOCATION</p><h2>Where the wealth sits</h2></div></div>
                  <div className="allocation-visual">
                    <div className="allocation-pie interactive-pie"><svg viewBox="0 0 42 42" aria-label="Interactive asset allocation">{allocationArcs.map((item) => <circle key={item.key} cx="21" cy="21" r="15.9155" fill="none" stroke={item.color} strokeWidth="9" pathLength="100" strokeDasharray={`${item.percent} ${100 - item.percent}`} strokeDashoffset={item.offset} role="button" tabIndex={0} aria-label={`${item.label}, ${item.percent.toFixed(1)} percent`} onClick={() => setSelectedAllocation(item.key as AssetClass)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedAllocation(item.key as AssetClass) }} />)}</svg><span><strong>{allocation.length}</strong>classes</span></div>
                    <div className="allocation-legend">{allocation.map((item) => <button key={item.key} onClick={() => setSelectedAllocation(item.key as AssetClass)}><span><i style={{ background: item.color }} />{item.label}</span><strong>{total ? ((item.value / total) * 100).toFixed(1) : '0.0'}%</strong><small>{formatMoney(item.value)}</small></button>)}</div>
                  </div>
                  {selectedAllocation && selectedAllocationItem && <div className="allocation-drilldown"><div className="drilldown-head"><span><i style={{ background: selectedAllocationItem.color }} /><strong>{selectedAllocationItem.label}</strong><small>{formatMoney(selectedAllocationItem.value)}</small></span><button onClick={() => setSelectedAllocation(null)} aria-label="Close allocation detail"><X size={14} /></button></div><p>Spread across platforms and addresses</p><div>{selectedAllocationPlatforms.map(([platform, value]) => <section key={platform}><span>{platform}</span><strong>{formatMoney(value)}</strong><small>{((value / selectedAllocationItem.value) * 100).toFixed(1)}%</small></section>)}</div></div>}
                </article>

                <article className="panel overview-digital">
                  <div className="panel-heading"><div><p className="eyebrow">DIGITAL ASSETS · &gt;$100</p><h2>Digital assets</h2></div><span>{cryptoExposure.length} assets</span></div>
                  <div className="asset-rows digital-rows">{cryptoExposure.map((asset) => {
                    const details = [...asset.breakdown.entries()].sort((a, b) => b[1].value - a[1].value)
                    const open = expandedDigital === asset.symbol
                    const pnl = asset.pricedValue - asset.pricedCost
                    const hasCost = asset.pricedQuantity > 0
                    return <div className={`expandable-asset ${open ? 'open' : ''}`} key={asset.symbol}>
                      <button onClick={() => setExpandedDigital(open ? null : asset.symbol)}><ChevronRight size={13} /><span className="symbol-cell"><strong>{asset.symbol}</strong><small>{details.slice(0, 2).map(([name, detail]) => `${name} ${((detail.value / asset.value) * 100).toFixed(0)}%`).join(' · ')}{details.length > 2 ? ` +${details.length - 2}` : ''}</small></span><b>{formatMoney(asset.value)}</b><span className={hasCost ? (pnl >= 0 ? 'asset-pnl value-positive' : 'asset-pnl value-negative') : 'asset-pnl'}>{hasCost ? `${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}` : 'Cost pending'}</span><em>{crypto ? ((asset.value / crypto) * 100).toFixed(1) : '0.0'}%</em></button>
                      {open && <div className="asset-breakdown digital-breakdown">{details.map(([name, detail]) => { const detailPnl = detail.pricedValue - detail.costBasis; const detailHasCost = detail.pricedQuantity > 0; return <div key={name}><span>{name}</span><strong>{formatAmount(detail.quantity)}</strong><small>{detailHasCost ? `Avg ${formatMoney(detail.costBasis / detail.pricedQuantity)}` : 'Average cost pending'}</small><b>{formatMoney(detail.value)}</b><em className={detailHasCost ? (detailPnl >= 0 ? 'value-positive' : 'value-negative') : ''}>{detailHasCost ? `${detailPnl >= 0 ? '+' : ''}${formatMoney(detailPnl)}` : '—'}</em></div> })}</div>}
                    </div>
                  })}</div>
                </article>

                <article className="panel overview-equities">
                  <div className="panel-heading"><div><p className="eyebrow">STOCKS &amp; ETFS</p><h2>{formatMoney(equities)} total</h2></div><div className="pnl-summary"><small>Total P/L</small><strong className={stockPnl >= 0 ? 'value-positive' : 'value-negative'}>{stockPnl >= 0 ? '+' : ''}{formatMoney(stockPnl)}</strong></div></div>
                  <div className="equity-columns"><span>Asset / venue split</span><span>Avg buy</span><span>Value</span><span>P/L</span><span>Allocation</span></div>
                  <div className="asset-rows equity-rows">{equityExposure.map((asset) => {
                    const details = [...asset.breakdown.entries()].sort((a, b) => b[1].value - a[1].value)
                    const open = expandedEquity === asset.symbol
                    const averageBuy = asset.pricedQuantity && asset.pricedCost ? asset.pricedCost / asset.pricedQuantity : null
                    const pnl = asset.pricedValue - asset.pricedCost
                    const hasCost = asset.pricedQuantity > 0
                    return <div className={`expandable-asset ${open ? 'open' : ''}`} key={asset.symbol}>
                      <button onClick={() => setExpandedEquity(open ? null : asset.symbol)}><ChevronRight size={13} /><span className="symbol-cell"><strong>{asset.symbol}</strong><small>{details.map(([name, value]) => `${name} ${((value.value / asset.value) * 100).toFixed(0)}%`).join(' · ')}</small></span><span>{averageBuy == null ? '—' : formatMoney(averageBuy)}</span><b>{formatMoney(asset.value)}</b><span className={hasCost ? (pnl >= 0 ? 'asset-pnl value-positive' : 'asset-pnl value-negative') : 'asset-pnl'}>{hasCost ? `${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}` : '—'}</span><em>{equities ? ((asset.value / equities) * 100).toFixed(1) : '0.0'}%</em></button>
                      {open && <div className="equity-detail"><div className="asset-breakdown equity-breakdown">{details.map(([name, detail]) => { const detailPnl = detail.value - detail.costBasis; const venueTransactions = (brokerageByAsset.get(asset.symbol) || []).filter((transaction) => transaction.account && platformIdentity(transaction.account) === name); return <button key={name} onClick={() => venueTransactions.length && setSelectedBrokerDetail({ symbol: asset.symbol, venue: name })} disabled={!venueTransactions.length}><span>{name}<small>{venueTransactions.length ? `${venueTransactions.length} transactions · click to open` : 'Position detail only'}</small></span><strong>{formatAmount(detail.quantity)} shares</strong><small>{detail.costBasis ? `Avg ${formatMoney(detail.costBasis / detail.quantity)}` : 'Average cost pending'}</small><b>{formatMoney(detail.value)}</b><em className={detail.costBasis ? (detailPnl >= 0 ? 'value-positive' : 'value-negative') : ''}>{detail.costBasis ? `${detailPnl >= 0 ? '+' : ''}${formatMoney(detailPnl)}` : '—'}</em><ChevronRight size={12} /></button> })}</div></div>}
                    </div>
                  })}</div>
                  <div className="equity-footer"><span>{equityExposure.length} securities · {formatMoney(stockCostBasis)} known cost</span><span>{brokerageTransactions.length ? `${formatMoney(realizedXtb)} XTB realized` : 'Realized P/L unavailable'}</span></div>
                  {selectedBrokerDetail && <div className="broker-drilldown"><div className="drilldown-head"><span><i /><strong>{selectedBrokerDetail.symbol} · {selectedBrokerDetail.venue}</strong><small>{selectedBrokerTransactions.length} records · sort any column or use the filters</small></span><button onClick={() => setSelectedBrokerDetail(null)} aria-label="Close transaction history"><X size={14} /></button></div><div className="broker-grid"><AgGridReact<TransactionGridRow> theme={portfolioGridTheme} rowData={transactionGridRows} columnDefs={transactionColumns} defaultColDef={{ sortable: true, resizable: true, floatingFilter: true }} getRowId={({ data }) => data.id} rowHeight={34} headerHeight={31} floatingFiltersHeight={29} /></div></div>}
                </article>

                <aside className="panel overview-spending">
                  <div className="panel-heading"><div><p className="eyebrow">LAST 30 DAYS</p><h2>Spending</h2></div><span>{formatMoney(recentSpendTotal)}</span></div>
                  {spendTransactions.length ? <><div className="spend-source-list">{spendBySource.map(([source, value]) => <div key={source}><span>{source}</span><strong>{formatMoney(value)}</strong></div>)}</div><div className="spend-divider" /><div className="recent-spend-list">{recentSpend.slice(0, 10).map((transaction) => <div key={transaction.id}><span><strong>{transaction.merchant || transaction.description || 'Card transaction'}</strong><small>{transaction.source} · {new Date(transaction.occurred_at).toLocaleDateString()}</small></span><b>{formatMoney(Math.abs(Number(transaction.amount_usd)))}</b></div>)}</div></> : <div className="spend-empty"><span>—</span><strong>No spending imported</strong><p>Ether.fi, KAST and Ethena transactions will appear here after their exports are added.</p></div>}
                </aside>
              </div>
            </section>
          )}

          {view === 'crypto' && (
            <section className="crypto-history-page">
              <div className="history-kpis">
                <article><span>Current digital wealth</span><strong>{formatMoney(currentDigitalValue)}</strong><small>Crypto, stablecoins, NFTs and tokenized gold</small></article>
                <article><span>Latest weekly change</span><strong className={cryptoWeeklyChange >= 0 ? 'value-positive' : 'value-negative'}>{cryptoWeeklyChange >= 0 ? '+' : ''}{formatMoney(cryptoWeeklyChange)}</strong><small>{priorCryptoPoint ? `Since ${new Date(`${priorCryptoPoint.date}T00:00:00`).toLocaleDateString()}` : 'A second weekly snapshot is required'}</small></article>
                <article><span>Since tracking began</span><strong className={cryptoSinceStart >= 0 ? 'value-positive' : 'value-negative'}>{cryptoSinceStart >= 0 ? '+' : ''}{formatMoney(cryptoSinceStart)}</strong><small>{firstCryptoPoint ? `From ${new Date(`${firstCryptoPoint.date}T00:00:00`).toLocaleDateString()}` : 'Historical backfill pending'}</small></article>
                <article><span>History coverage</span><strong>{cryptoHistory.length} weeks</strong><small>{firstCryptoPoint && latestCryptoPoint ? `${firstCryptoPoint.date} → ${latestCryptoPoint.date}` : 'No snapshots available'}</small></article>
              </div>

              <div className="history-grid">
                <article className="panel history-chart-panel">
                  <div className="panel-heading"><div><p className="eyebrow">WEEKLY ADDRESS SNAPSHOTS</p><h2>Crypto wealth over time</h2></div><span>{latestCryptoPoint ? formatMoney(latestCryptoPoint.total) : 'Pending'}</span></div>
                  {cryptoHistory.length ? <div className="history-chart"><div className="chart-scale"><span>{formatMoney(cryptoChartMax)}</span><span>{formatMoney(cryptoChartMin)}</span></div><svg viewBox="0 0 1000 300" preserveAspectRatio="none" role="img" aria-label="Weekly crypto wealth chart"><defs><linearGradient id="cryptoArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#68d3a0" stopOpacity=".32" /><stop offset="1" stopColor="#68d3a0" stopOpacity="0" /></linearGradient></defs><path d={`M ${cryptoChartPoints.replaceAll(' ', ' L ')} L 1000,300 L 0,300 Z`} fill="url(#cryptoArea)" /><polyline points={cryptoChartPoints} fill="none" stroke="#68d3a0" strokeWidth="4" vectorEffect="non-scaling-stroke" />{cryptoHistory.map((point, index) => { const [x, y] = cryptoChartPoints.split(' ')[index].split(','); return <circle key={point.date} cx={x} cy={y} r="5" fill="#0d1216" stroke="#68d3a0"><title>{point.date}: {formatMoney(point.total)}</title></circle> })}</svg><div className="chart-dates"><span>{firstCryptoPoint?.date}</span><span>{latestCryptoPoint?.date}</span></div></div> : <div className="history-empty"><Coins size={24} /><strong>Historical backfill not loaded yet</strong><p>The first observed snapshot is available after a successful sync. Reconstructed weekly history from 2018 requires an indexed historical-balance API.</p></div>}
                </article>

                <article className="panel history-address-panel">
                  <div className="panel-heading"><div><p className="eyebrow">ADDRESS / PLATFORM</p><h2>Latest composition</h2></div><span>{cryptoPlatformRows.length}</span></div>
                  <div className="history-address-list">{cryptoPlatformRows.map((row) => { const delta = row.value - row.start; return <div key={row.platform}><span><strong>{row.platform}</strong><small>{latestCryptoPoint ? ((row.value / latestCryptoPoint.total) * 100).toFixed(1) : '0.0'}% of digital wealth</small></span><b>{formatMoney(row.value)}</b><em className={delta >= 0 ? 'value-positive' : 'value-negative'}>{delta >= 0 ? '+' : ''}{formatMoney(delta)}</em></div> })}</div>
                </article>

                <article className="panel history-method-panel">
                  <div><p className="eyebrow">VALUATION METHOD</p><h2>Observed vs reconstructed</h2></div>
                  <p><strong>Observed</strong> snapshots use the balances and USD prices returned during each weekly sync. They are the source of truth going forward.</p>
                  <p><strong>Reconstructed</strong> history uses historical balances at each weekly block plus that asset’s USD price on the same date. It will be labelled separately because DeFi receipt tokens and unsupported protocols may not reconstruct perfectly.</p>
                  <span>Only positions worth at least $100 on that historical date are retained in the backfill.</span>
                </article>
              </div>
            </section>
          )}

          {view === 'holdings' && (
            <section className="panel holdings-panel">
              <div className="table-tools"><label><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search assets or accounts" /></label><span>{filteredPositions.length} positions · click headers to sort</span></div>
              {positions.length ? (
                <div className="holdings-grid"><AgGridReact<HoldingGridRow> theme={portfolioGridTheme} rowData={holdingGridRows} columnDefs={holdingColumns} defaultColDef={{ sortable: true, resizable: true, floatingFilter: true }} quickFilterText={search} getRowId={({ data }) => data.id} rowHeight={42} headerHeight={34} floatingFiltersHeight={31} /></div>
              ) : <EmptyState onAdd={() => setShowHoldingForm(true)} />}
            </section>
          )}

          {view === 'activity' && (
            <section className="panel compact-panel">
              <div className="panel-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Sync history</h2></div><span>{syncRuns.length} recent runs</span></div>
              {syncRuns.length ? <div className="table-scroll"><table className="dense-table"><thead><tr><th>Source</th><th>Status</th><th>Records</th><th>Started</th><th>Message</th></tr></thead><tbody>{syncRuns.map((run) => <tr key={run.id}><td><strong>{run.source}</strong></td><td><span className={`status-pill ${run.status}`}>{run.status}</span></td><td>{run.records_written}</td><td>{new Date(run.started_at).toLocaleString()}</td><td>{run.message || '—'}</td></tr>)}</tbody></table></div> : <EmptyState compact />}
            </section>
          )}
        </div>
      </main>
      {showHoldingForm && <HoldingForm accounts={accounts} onClose={() => setShowHoldingForm(false)} onSaved={load} />}
    </div>
  )
}

function EmptyState({ compact = false, onAdd }: { compact?: boolean; onAdd?: () => void }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="icon-tile"><Layers3 size={22} /></div><strong>Your portfolio is ready for data</strong><p>Connect an importer or add the first holding manually.</p>{onAdd && <button className="primary-button compact" onClick={onAdd}><Plus size={17} />Add holding</button>}</div>
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setReady(true) })
    return () => data.subscription.unsubscribe()
  }, [])

  if (!isConfigured) return <ConfigurationNotice />
  if (!ready) return <div className="loading-screen"><Sparkles size={24} /><span>Opening Northstar…</span></div>
  return session ? <Dashboard session={session} /> : <Login />
}
