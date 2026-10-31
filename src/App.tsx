import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { Area, AreaChart, Brush, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  ExternalLink,
  Layers3,
  LogOut,
  Maximize2,
  Menu,
  Minimize2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { isConfigured, supabase } from './lib/supabase'
import type { Account, AssetClass, BrokerageTransaction, LossEvent, Position, PositionSnapshot, Snapshot, SpendTransaction, SyncRun } from './types'

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

type EquityGridRow = {
  symbol: string
  name: string
  venueSplit: string
  averageBuy: number | null
  value: number
  pnl: number | null
  realizedPnl: number | null
  allocation: number
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

type View = 'overview' | 'crypto' | 'losses' | 'holdings' | 'activity'
type OverviewPanel = 'platforms' | 'allocation' | 'digital' | 'equities' | 'spending'
type DisplayCurrency = 'USD' | 'INR'
type CryptoRange = '3M' | '6M' | '1Y' | '3Y' | 'ALL'

const cryptoRanges: CryptoRange[] = ['3M', '6M', '1Y', '3Y', 'ALL']
const cryptoRangeDays: Record<Exclude<CryptoRange, 'ALL'>, number> = { '3M': 92, '6M': 183, '1Y': 365, '3Y': 1096 }

function sampleEvenly<T>(values: T[], maximum: number) {
  if (values.length <= maximum) return values
  return Array.from({ length: maximum }, (_, index) => values[Math.round((index * (values.length - 1)) / (maximum - 1))])
}

function cryptoWeekBucket(date: string) {
  const value = new Date(`${date}T00:00:00Z`)
  const daysSinceTuesday = (value.getUTCDay() + 5) % 7
  value.setUTCDate(value.getUTCDate() - daysSinceTuesday)
  return value.toISOString().slice(0, 10)
}

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const moneyCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatMoney(value: number) {
  return money.format(Number.isFinite(value) ? value : 0)
}

function formatMoneyCents(value: number) {
  return moneyCents.format(Number.isFinite(value) ? value : 0)
}

function formatAmount(value: number) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value)
}

async function fetchAllPositionSnapshots() {
  const pageSize = 1000
  const rows: PositionSnapshot[] = []
  for (let from = 0; ; from += pageSize) {
    const result = await supabase
      .from('position_snapshots')
      .select('snapshot_date,source_key,quantity,price_usd,value_usd,account:accounts(name,institution),asset:assets(symbol,name,asset_class,network)')
      .order('snapshot_date', { ascending: true })
      .order('source_key', { ascending: true })
      .range(from, from + pageSize - 1)
    if (result.error) return { data: rows, error: result.error }
    rows.push(...((result.data || []) as unknown as PositionSnapshot[]))
    if ((result.data || []).length < pageSize) return { data: rows, error: null }
  }
}

function spendCashback(transaction: SpendTransaction) {
  const value = Number(transaction.metadata?.cashback_earned || 0)
  return Number.isFinite(value) ? value : 0
}

function spendTransactionUrl(transaction: SpendTransaction) {
  const metadata = transaction.metadata || {}
  const explicitUrl = String(metadata.explorer_url || metadata.transaction_url || '')
  if (/^https:\/\//i.test(explicitUrl)) return explicitUrl
  const transactionHash = String(metadata.transaction_hash || metadata.tx_hash || '')
  return /^0x[a-fA-F0-9]{64}$/.test(transactionHash) ? `https://blockscan.com/tx/${transactionHash}` : null
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
  const normalized = match?.[0].toLowerCase()
  return normalized ? `${normalized.slice(0, 6)}…${normalized.slice(-4)}` : null
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

function networkSlug(network: string | null) {
  const normalized = String(network || 'chain').toLowerCase()
  const aliases: Record<string, string> = { ethereum: 'eth', arbitrum: 'arb', optimism: 'op', polygon: 'pol', 'bnb chain': 'bnb', hyperevm: 'hype', hyperliquid: 'hyperliquid' }
  return aliases[normalized] || normalized.replace(/\s+/g, '-')
}

function digitalPositionLocation(position: Position) {
  const platform = positionPlatform(position)
  if (!platform.startsWith('0x')) return platform
  const network = networkSlug(position.asset.network)
  const identity = `${position.account.name} ${position.account.institution}`.toLowerCase()
  if (identity.includes('hyperliquid')) {
    const location = identity.includes('lending') ? 'lending' : identity.includes('staking') ? 'staking' : identity.includes('vault') ? 'vault' : identity.includes('perps') ? 'perps' : 'spot'
    return `${platform} · hyperliquid-${location}`
  }
  const accountContext = position.account.name.split(' · ').at(-1) || ''
  const isDirectWallet = accountContext.toLowerCase() === String(position.asset.network || '').toLowerCase() || accountContext === String(position.metadata?.chain_id || '')
  return `${platform} · ${isDirectWallet ? 'native' : accountContext.toLowerCase().replace(/\s+/g, '-')}-${network}`
}

function cardSourceForPosition(position: Position) {
  const identity = `${position.account.name} ${position.account.institution}`.toLowerCase()
  if (/ether\.?fi/.test(identity)) return 'ether.fi'
  if (identity.includes('kast')) return 'kast'
  if (identity.includes('ethena')) return 'ethena'
  return null
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
  const [lossEvents, setLossEvents] = useState<LossEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showHoldingForm, setShowHoldingForm] = useState(false)
  const [expandedDigital, setExpandedDigital] = useState<string | null>(null)
  const [expandedEquity, setExpandedEquity] = useState<string | null>(null)
  const [selectedAllocation, setSelectedAllocation] = useState<AssetClass | null>(null)
  const [selectedBrokerDetail, setSelectedBrokerDetail] = useState<{ symbol: string; venue: string } | null>(null)
  const [brokerFullscreen, setBrokerFullscreen] = useState(false)
  const [expandedPanel, setExpandedPanel] = useState<OverviewPanel | null>(null)
  const [spendMonth, setSpendMonth] = useState(new Date().toISOString().slice(0, 7))
  const [selectedCardSources, setSelectedCardSources] = useState(['ether.fi', 'kast', 'ethena'])
  const [selectedActivityTypes, setSelectedActivityTypes] = useState(['purchase', 'refund', 'cashback'])
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(() => localStorage.getItem('northstar-currency') === 'INR' ? 'INR' : 'USD')
  const [cryptoRange, setCryptoRange] = useState<CryptoRange>('1Y')
  const [selectedCryptoPlatform, setSelectedCryptoPlatform] = useState('all')
  const inrPerUsd = useMemo(() => {
    const indiaPosition = positions.find((position) => position.source_key === 'india:inr')
    const quantity = Number(indiaPosition?.quantity || 0)
    const value = Number(indiaPosition?.value_usd || 0)
    return quantity > 0 && value > 0 ? quantity / value : 95.13
  }, [positions])
  const currencyFormatter = useMemo(() => new Intl.NumberFormat(displayCurrency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: displayCurrency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), [displayCurrency])
  const currencyFormatterCents = useMemo(() => new Intl.NumberFormat(displayCurrency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: displayCurrency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), [displayCurrency])
  const displayRate = displayCurrency === 'INR' ? inrPerUsd : 1
  const compactCurrencyFormatter = useMemo(() => new Intl.NumberFormat(displayCurrency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: displayCurrency, notation: 'compact', maximumFractionDigits: 1 }), [displayCurrency])
  const formatMoney = useCallback((value: number) => currencyFormatter.format((Number.isFinite(value) ? value : 0) * displayRate), [currencyFormatter, displayRate])
  const formatMoneyCents = useCallback((value: number) => currencyFormatterCents.format((Number.isFinite(value) ? value : 0) * displayRate), [currencyFormatterCents, displayRate])
  const formatCompactMoney = useCallback((value: number) => compactCurrencyFormatter.format((Number.isFinite(value) ? value : 0) * displayRate), [compactCurrencyFormatter, displayRate])

  useEffect(() => { localStorage.setItem('northstar-currency', displayCurrency) }, [displayCurrency])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [positionsResult, accountsResult, snapshotsResult, positionSnapshotsResult, syncRunsResult, brokerageResult, spendResult, lossEventsResult] = await Promise.all([
      supabase.from('positions').select('*, account:accounts(*), asset:assets(*)').order('value_usd', { ascending: false }),
      supabase.from('accounts').select('*').order('name'),
      supabase.from('portfolio_snapshots').select('*').order('snapshot_date', { ascending: true }).limit(90),
      fetchAllPositionSnapshots(),
      supabase.from('sync_runs').select('id,source,status,records_written,message,started_at,finished_at').order('started_at', { ascending: false }).limit(20),
      supabase.from('brokerage_transactions').select('id,event_time,event_type,quantity,price_usd,amount_usd,realized_pnl_usd,account:accounts(name,institution),asset:assets(symbol,name)').order('event_time', { ascending: false }).limit(1000),
      supabase.from('spend_transactions').select('id,source,occurred_at,merchant,description,amount_usd,category,status,transaction_type,metadata').order('occurred_at', { ascending: false }).limit(5000),
      supabase.from('loss_events').select('id,event_key,event_at,date_precision,title,category,status,loss_low_usd,loss_high_usd,details').order('event_at', { ascending: false, nullsFirst: false }),
    ])
    const failure = positionsResult.error || accountsResult.error || snapshotsResult.error || positionSnapshotsResult.error || syncRunsResult.error || brokerageResult.error || spendResult.error || lossEventsResult.error
    if (failure) setError(failure.message)
    setPositions((positionsResult.data || []) as unknown as Position[])
    setAccounts((accountsResult.data || []) as Account[])
    setSnapshots((snapshotsResult.data || []) as Snapshot[])
    setPositionSnapshots(positionSnapshotsResult.data || [])
    setSyncRuns((syncRunsResult.data || []) as SyncRun[])
    setBrokerageTransactions((brokerageResult.data || []) as unknown as BrokerageTransaction[])
    setSpendTransactions((spendResult.data || []) as SpendTransaction[])
    setLossEvents((lossEventsResult.data || []) as LossEvent[])
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
      const platform = digitalPositionLocation(position)
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
  const equityGridRows = useMemo<EquityGridRow[]>(() => equityExposure.map((asset) => ({
    symbol: asset.symbol,
    name: asset.name,
    venueSplit: [...asset.breakdown.entries()].sort((a, b) => b[1].value - a[1].value).map(([name, detail]) => `${name} ${asset.value ? ((detail.value / asset.value) * 100).toFixed(0) : '0'}%`).join(' · '),
    averageBuy: asset.pricedQuantity && asset.pricedCost ? asset.pricedCost / asset.pricedQuantity : null,
    value: asset.value,
    pnl: asset.pricedQuantity ? asset.pricedValue - asset.pricedCost : null,
    realizedPnl: brokerageTransactions.some((transaction) => transaction.asset?.symbol && canonicalEquitySymbol(transaction.asset.symbol) === asset.symbol && transaction.realized_pnl_usd != null)
      ? brokerageTransactions.filter((transaction) => transaction.asset?.symbol && canonicalEquitySymbol(transaction.asset.symbol) === asset.symbol).reduce((sum, transaction) => sum + Number(transaction.realized_pnl_usd || 0), 0)
      : null,
    allocation: equities ? (asset.value / equities) * 100 : 0,
  })), [brokerageTransactions, equities, equityExposure])
  const equityColumns = useMemo<ColDef<EquityGridRow>[]>(() => [
    { field: 'symbol', headerName: 'Asset / venue', minWidth: 105, flex: 1.8, filter: 'agTextColumnFilter', cellRenderer: ({ data }: { data?: EquityGridRow }) => data ? <span className="grid-asset"><strong>{data.symbol}</strong><small>{data.venueSplit || data.name}</small></span> : null },
    { field: 'averageBuy', headerName: 'Avg buy', minWidth: 60, flex: .8, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : formatMoneyCents(Number(value)) },
    { field: 'value', headerName: 'Value', minWidth: 65, flex: .9, sort: 'desc', filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => formatMoney(Number(value)) },
    { field: 'pnl', headerName: 'Unrealized', minWidth: 65, flex: .9, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${formatMoney(Number(value))}`, cellClass: ({ value }) => value == null ? '' : Number(value) >= 0 ? 'grid-pnl-positive' : 'grid-pnl-negative' },
    { field: 'realizedPnl', headerName: 'Realized', minWidth: 65, flex: .9, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${formatMoney(Number(value))}`, cellClass: ({ value }) => value == null ? '' : Number(value) >= 0 ? 'grid-pnl-positive' : 'grid-pnl-negative' },
    { field: 'allocation', headerName: 'Alloc.', minWidth: 50, flex: .6, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => `${Number(value).toFixed(1)}%` },
  ], [formatMoney, formatMoneyCents])
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
  const displayBrokerTransactions = useMemo(() => {
    const dayKey = (transaction: BrokerageTransaction) => transaction.event_time.slice(0, 10)
    const closedDays = new Set(selectedBrokerTransactions.filter((transaction) => transaction.event_type.toLowerCase() === 'closed position').map(dayKey))
    return selectedBrokerTransactions.filter((transaction) => {
      const eventType = transaction.event_type.toLowerCase()
      return !(eventType === 'stock sell' && closedDays.has(dayKey(transaction)))
    })
  }, [selectedBrokerTransactions])
  const transactionGridRows = useMemo<TransactionGridRow[]>(() => displayBrokerTransactions.map((transaction) => {
    const rawType = transaction.event_type.toLowerCase()
    const eventType = rawType === 'stock purchase' ? 'Buy' : rawType === 'stock sell' || rawType === 'closed position' ? 'Sell' : transaction.event_type
    return {
    id: transaction.id,
    eventTime: new Date(transaction.event_time),
    eventType,
    asset: transaction.asset?.name || transaction.asset?.symbol || selectedBrokerDetail?.symbol || '',
    quantity: transaction.quantity == null ? null : Number(transaction.quantity),
    price: transaction.price_usd == null ? null : Number(transaction.price_usd),
    amount: transaction.amount_usd == null ? null : Number(transaction.amount_usd),
    realizedPnl: transaction.realized_pnl_usd == null ? null : Number(transaction.realized_pnl_usd),
  }}), [displayBrokerTransactions, selectedBrokerDetail])
  const displayedBuyCount = transactionGridRows.filter((transaction) => transaction.eventType === 'Buy').length
  const displayedSellCount = transactionGridRows.filter((transaction) => transaction.eventType === 'Sell').length
  const displayedRealizedPnl = transactionGridRows.reduce((sum, transaction) => sum + Number(transaction.realizedPnl || 0), 0)
  const transactionColumns = useMemo<ColDef<TransactionGridRow>[]>(() => [
    { field: 'eventTime', headerName: 'Date', minWidth: 105, sort: 'desc', filter: 'agDateColumnFilter', valueFormatter: ({ value }) => value instanceof Date ? value.toLocaleDateString() : '—' },
    { field: 'eventType', headerName: 'Trade', minWidth: 90, filter: 'agTextColumnFilter' },
    { field: 'asset', headerName: 'Asset', minWidth: 150, flex: 1, filter: 'agTextColumnFilter' },
    { field: 'quantity', headerName: 'Quantity', minWidth: 105, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : formatAmount(Number(value)) },
    { field: 'price', headerName: 'Price', minWidth: 100, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : formatMoneyCents(Number(value)) },
    { field: 'amount', headerName: 'Amount', minWidth: 105, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : formatMoney(Number(value)) },
    { field: 'realizedPnl', headerName: 'Realized P/L', minWidth: 115, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${formatMoney(Number(value))}`, cellClass: ({ value }) => value == null ? '' : Number(value) >= 0 ? 'grid-pnl-positive' : 'grid-pnl-negative' },
  ], [formatMoney, formatMoneyCents])
  const cryptoHistory = useMemo(() => {
    type AssetBalance = { label: string; value: number; quantity: number }
    type HistoryPoint = { date: string; total: number; platforms: Map<string, number>; assets: Map<string, Map<string, AssetBalance>> }
    const grouped = new Map<string, HistoryPoint>()
    positionSnapshots.forEach((snapshot) => {
      if (!snapshot.asset || !snapshot.account || !isDigitalAsset(snapshot.asset)) return
      const week = cryptoWeekBucket(snapshot.snapshot_date)
      const current = grouped.get(week) || { date: week, total: 0, platforms: new Map<string, number>(), assets: new Map<string, Map<string, AssetBalance>>() }
      const value = Number(snapshot.value_usd)
      const platform = platformIdentity(snapshot.account, snapshot.source_key)
      const network = snapshot.asset.network ? ` · ${snapshot.asset.network}` : ''
      const assetKey = `${snapshot.asset.symbol}${network}`
      const platformAssets = current.assets.get(platform) || new Map<string, AssetBalance>()
      const asset = platformAssets.get(assetKey) || { label: assetKey, value: 0, quantity: 0 }
      current.total += value
      current.platforms.set(platform, (current.platforms.get(platform) || 0) + value)
      asset.value += value
      asset.quantity += Number(snapshot.quantity || 0)
      platformAssets.set(assetKey, asset)
      current.assets.set(platform, platformAssets)
      grouped.set(week, current)
    })
    return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [positionSnapshots])
  const cryptoPlatforms = useMemo(() => [...new Set(cryptoHistory.flatMap((point) => [...point.platforms.keys()]))].sort(), [cryptoHistory])
  const selectedCryptoHistory = useMemo(() => cryptoHistory
    .filter((point) => selectedCryptoPlatform === 'all' || point.platforms.has(selectedCryptoPlatform))
    .map((point) => ({
      ...point,
      total: selectedCryptoPlatform === 'all' ? point.total : point.platforms.get(selectedCryptoPlatform) as number,
    })), [cryptoHistory, selectedCryptoPlatform])
  const rangedCryptoHistory = useMemo(() => {
    if (cryptoRange === 'ALL' || !selectedCryptoHistory.length) return selectedCryptoHistory
    const latest = new Date(`${selectedCryptoHistory[selectedCryptoHistory.length - 1].date}T00:00:00Z`)
    latest.setUTCDate(latest.getUTCDate() - cryptoRangeDays[cryptoRange])
    const cutoff = latest.toISOString().slice(0, 10)
    return selectedCryptoHistory.filter((point) => point.date >= cutoff)
  }, [selectedCryptoHistory, cryptoRange])
  const chartCryptoHistory = useMemo(() => sampleEvenly(rangedCryptoHistory, 52), [rangedCryptoHistory])
  const cryptoChartData = useMemo(() => chartCryptoHistory.map((point) => ({ date: point.date, value: point.total })), [chartCryptoHistory])
  const currentDigitalValue = positions.filter((position) => isDigitalAsset(position.asset)).reduce((sum, position) => sum + Number(position.value_usd), 0)
  const firstCryptoPoint = cryptoHistory[0]
  const latestCryptoPoint = cryptoHistory[cryptoHistory.length - 1]
  const firstRangeCryptoPoint = rangedCryptoHistory[0]
  const latestRangeCryptoPoint = rangedCryptoHistory[rangedCryptoHistory.length - 1]
  const priorCryptoPoint = cryptoHistory[cryptoHistory.length - 2]
  const cryptoWeeklyChange = latestCryptoPoint && priorCryptoPoint ? latestCryptoPoint.total - priorCryptoPoint.total : 0
  const cryptoSinceStart = latestCryptoPoint && firstCryptoPoint ? latestCryptoPoint.total - firstCryptoPoint.total : 0
  const cryptoCompositionTotal = latestCryptoPoint
    ? selectedCryptoPlatform === 'all' ? latestCryptoPoint.total : latestCryptoPoint.platforms.get(selectedCryptoPlatform) || 0
    : 0
  const cryptoPlatformRows = latestCryptoPoint
    ? selectedCryptoPlatform === 'all'
      ? [...latestCryptoPoint.platforms.entries()].map(([platform, value]) => ({ platform, value, quantity: null as number | null, start: firstRangeCryptoPoint?.platforms.get(platform) || 0 })).sort((a, b) => b.value - a.value)
      : [...(latestCryptoPoint.assets.get(selectedCryptoPlatform)?.values() || [])].map((asset) => ({ platform: asset.label, value: asset.value, quantity: asset.quantity, start: firstRangeCryptoPoint?.assets.get(selectedCryptoPlatform)?.get(asset.label)?.value || 0 })).sort((a, b) => b.value - a.value)
    : []
  const realizedXtb = brokerageTransactions.reduce((sum, transaction) => sum + Number(transaction.realized_pnl_usd || 0), 0)
  const cardBalances = positions.filter((position) => { const source = cardSourceForPosition(position); return source && selectedCardSources.includes(source) }).sort((a, b) => Number(b.value_usd) - Number(a.value_usd))
  const cardBalanceTotal = cardBalances.reduce((sum, position) => sum + Number(position.value_usd), 0)
  const spendMonths = [...new Set(spendTransactions.map((transaction) => transaction.occurred_at.slice(0, 7)))].sort()
  const minSpendMonth = spendMonths[0] || spendMonth
  const maxSpendMonth = spendMonths[spendMonths.length - 1] || spendMonth
  const selectedMonthLabel = new Date(`${spendMonth}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const selectedCardActivity = spendTransactions.filter((transaction) => selectedCardSources.includes(transaction.source) && transaction.occurred_at.slice(0, 7) === spendMonth && String(transaction.status).trim().toLowerCase() === 'cleared')
  const recentPurchases = selectedCardActivity.filter((transaction) => transaction.transaction_type === 'purchase')
  const recentRefunds = selectedCardActivity.filter((transaction) => transaction.transaction_type === 'refund')
  const recentCashback = selectedCardActivity.filter((transaction) => transaction.transaction_type === 'cashback')
  const visibleCardActivity = selectedCardActivity.filter((transaction) => selectedActivityTypes.includes(transaction.transaction_type)).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
  const recentSpendTotal = recentPurchases.reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount_usd)), 0)
  const recentRefundTotal = recentRefunds.reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount_usd)), 0)
  const recentCashbackTotal = recentCashback.reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount_usd)), 0)
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
    { field: 'price', headerName: 'Price', minWidth: 105, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => formatMoneyCents(Number(value)) },
    { field: 'value', headerName: 'Value', minWidth: 115, sort: 'desc', filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => formatMoney(Number(value)) },
    { field: 'pnl', headerName: 'P/L', minWidth: 115, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${formatMoney(Number(value))}`, cellClass: ({ value }) => value == null ? '' : Number(value) >= 0 ? 'grid-pnl-positive' : 'grid-pnl-negative' },
    { field: 'weight', headerName: 'Weight', minWidth: 100, filter: 'agNumberColumnFilter', valueFormatter: ({ value }) => `${Number(value).toFixed(2)}%` },
  ], [formatMoney, formatMoneyCents])
  const lossTotalLow = lossEvents.reduce((sum, event) => sum + Number(event.loss_low_usd || 0), 0)
  const lossTotalHigh = lossEvents.reduce((sum, event) => sum + Number(event.loss_high_usd || event.loss_low_usd || 0), 0)
  const realizedLoss = lossEvents.filter((event) => event.status === 'realized').reduce((sum, event) => sum + Number(event.loss_low_usd || 0), 0)
  const unrealizedLoss = lossEvents.filter((event) => ['unrealized', 'mixed'].includes(event.status)).reduce((sum, event) => sum + Number(event.loss_low_usd || 0), 0)
  const pendingLossEvents = lossEvents.filter((event) => event.status === 'pending' || event.loss_low_usd == null).length
  const lossColumns = useMemo<ColDef<LossEvent>[]>(() => [
    { field: 'event_at', headerName: 'Date / time', minWidth: 145, filter: 'agDateColumnFilter', valueFormatter: ({ value, data }) => { if (!value || data?.date_precision === 'unknown') return 'Unconfirmed'; const date = new Date(value); if (data?.date_precision === 'month') return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }); const label = date.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }); return data?.date_precision === 'valuation_date' ? `${label} valuation` : label } },
    { field: 'title', headerName: 'Event', minWidth: 210, flex: 1, filter: 'agTextColumnFilter', cellRenderer: ({ data }: { data?: LossEvent }) => data ? <span className="grid-asset"><strong>{data.title}</strong><small>{data.category}</small></span> : null },
    { field: 'status', headerName: 'Status', minWidth: 110, filter: 'agTextColumnFilter', cellClass: ({ value }) => `loss-status-${value}` },
    { field: 'loss_low_usd', headerName: 'Estimated loss', minWidth: 155, filter: 'agNumberColumnFilter', valueFormatter: ({ data }) => { if (!data || data.loss_low_usd == null) return 'Pending'; const low = Number(data.loss_low_usd); const high = Number(data.loss_high_usd ?? low); return low === high ? `-${formatMoney(low)}` : `-${formatMoney(low)} to -${formatMoney(high)}` }, cellClass: 'grid-pnl-negative' },
    { field: 'details', headerName: 'Reconciliation details', minWidth: 360, flex: 2, filter: 'agTextColumnFilter', wrapText: true, autoHeight: true },
  ], [formatMoney])

  const navItems: Array<{ id: View; label: string; icon: typeof BarChart3 }> = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'crypto', label: 'Crypto value', icon: Coins },
    { id: 'losses', label: 'Losses', icon: AlertTriangle },
    { id: 'holdings', label: 'Holdings', icon: Layers3 },
    { id: 'activity', label: 'Activity', icon: Activity },
  ]

  function chooseView(next: View) {
    setView(next)
    setMobileNav(false)
  }

  function shiftSpendMonth(delta: number) {
    const [year, month] = spendMonth.split('-').map(Number)
    const next = new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 7)
    if (next >= minSpendMonth && next <= maxSpendMonth) setSpendMonth(next)
  }

  function overviewPanelClass(panel: OverviewPanel, base: string) {
    return `panel ${base} ${expandedPanel === panel ? 'panel-expanded' : ''}`
  }

  function toggleCardSource(source: string) {
    setSelectedCardSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source])
  }

  function toggleActivityType(type: string) {
    setSelectedActivityTypes((current) => current.includes(type) ? current.filter((item) => item !== type) : [...current, type])
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
          <div className="topbar-actions"><div className="notional-toggle" aria-label="Display notional currency"><span>Notional</span>{(['USD', 'INR'] as DisplayCurrency[]).map((currency) => <button key={currency} className={displayCurrency === currency ? 'active' : ''} onClick={() => setDisplayCurrency(currency)}>{currency}</button>)}</div><div className="profile-wrap"><button className="profile-button" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen}><span>{session.user.email?.slice(0, 1).toUpperCase()}</span><ChevronDown size={15} /></button>{profileOpen && <div className="profile-menu"><strong>{session.user.email}</strong><small>Approved portfolio access</small><button onClick={() => supabase.auth.signOut()}><LogOut size={15} />Sign out</button></div>}</div></div>
        </header>

        <div className={`page-content ${view === 'overview' ? 'overview-page' : ''}`}>
          {view !== 'overview' && <div className="page-heading">
            <div><p className="eyebrow">{view.toUpperCase()}</p><h1>{view === 'crypto' ? 'Crypto value history' : view === 'losses' ? 'Loss history' : view === 'holdings' ? 'All holdings' : 'Portfolio activity'}</h1></div>
            <div className="heading-actions"><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spinning' : ''} />Refresh</button>{view === 'holdings' && <button className="primary-button compact" onClick={() => setShowHoldingForm(true)}><Plus size={17} />Add holding</button>}</div>
          </div>}

          {error && <div className="error-banner"><ShieldCheck size={18} /><span>{error}</span></div>}

          {view === 'overview' && (
            <section className="overview-dashboard">
              <div className="overview-kpis">
                <article className="wealth-strip"><section><span>Net worth</span><strong>{loading ? '—' : formatMoney(total)}</strong></section><section><span>Cash available</span><strong>{formatMoney(liquid)}</strong><small>{total ? `${((liquid / total) * 100).toFixed(1)}%` : '—'}</small></section><section><span>Invested</span><strong>{formatMoney(total - liquid)}</strong><small>{total ? `${(((total - liquid) / total) * 100).toFixed(1)}%` : '—'}</small></section><p className={previous && change < 0 ? 'negative' : 'positive'}>{previous ? (change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />) : <ShieldCheck size={12} />}{snapshotMessage}</p></article>
              </div>

              <div className="overview-grid">
                <article className={overviewPanelClass('platforms', 'overview-platforms')}>
                  <div className="panel-heading"><div><p className="eyebrow">BY PLATFORM / ADDRESS</p><h2>Portfolio network</h2></div><div className="panel-heading-actions"><span className="panel-badge">{platformTotals.length}</span><button className="panel-expand-button" onClick={() => setExpandedPanel(expandedPanel === 'platforms' ? null : 'platforms')} aria-label="Expand portfolio network">{expandedPanel === 'platforms' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button></div></div>
                  <div className="platform-list">{platformTotals.map((source) => <div key={source.name}><span><strong>{source.name}</strong><small>{total ? ((source.value / total) * 100).toFixed(1) : '0.0'}%</small></span><b>{formatMoney(source.value)}</b></div>)}</div>
                </article>

                <article className={overviewPanelClass('allocation', 'overview-allocation')}>
                  <div className="panel-heading"><div><p className="eyebrow">ASSET ALLOCATION</p><h2>Where the wealth sits</h2></div><button className="panel-expand-button" onClick={() => setExpandedPanel(expandedPanel === 'allocation' ? null : 'allocation')} aria-label="Expand asset allocation">{expandedPanel === 'allocation' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button></div>
                  <div className="allocation-visual">
                    <div className="allocation-pie interactive-pie"><svg viewBox="0 0 42 42" aria-label="Interactive asset allocation">{allocationArcs.map((item) => <circle key={item.key} cx="21" cy="21" r="15.9155" fill="none" stroke={item.color} strokeWidth="9" pathLength="100" strokeDasharray={`${item.percent} ${100 - item.percent}`} strokeDashoffset={item.offset} role="button" tabIndex={0} aria-label={`${item.label}, ${item.percent.toFixed(1)} percent`} onClick={() => setSelectedAllocation(item.key as AssetClass)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedAllocation(item.key as AssetClass) }} />)}</svg><span><strong>{allocation.length}</strong>classes</span></div>
                    <div className="allocation-legend">{allocation.map((item) => <button key={item.key} onClick={() => setSelectedAllocation(item.key as AssetClass)}><span><i style={{ background: item.color }} />{item.label}</span><strong>{total ? ((item.value / total) * 100).toFixed(1) : '0.0'}%</strong><small>{formatMoney(item.value)}</small></button>)}</div>
                  </div>
                  {selectedAllocation && selectedAllocationItem && <div className="allocation-drilldown"><div className="drilldown-head"><span><i style={{ background: selectedAllocationItem.color }} /><strong>{selectedAllocationItem.label}</strong><small>{formatMoney(selectedAllocationItem.value)}</small></span><button onClick={() => setSelectedAllocation(null)} aria-label="Close allocation detail"><X size={14} /></button></div><p>Spread across platforms and addresses</p><div>{selectedAllocationPlatforms.map(([platform, value]) => <section key={platform}><span>{platform}</span><strong>{formatMoney(value)}</strong><small>{((value / selectedAllocationItem.value) * 100).toFixed(1)}%</small></section>)}</div></div>}
                </article>

                <article className={overviewPanelClass('digital', 'overview-digital')}>
                  <div className="panel-heading"><div><p className="eyebrow">DIGITAL ASSETS · &gt;$100</p><h2>Digital assets</h2></div><div className="panel-heading-actions"><span className="panel-badge">{cryptoExposure.length} assets</span><button className="panel-expand-button" onClick={() => setExpandedPanel(expandedPanel === 'digital' ? null : 'digital')} aria-label="Expand digital assets">{expandedPanel === 'digital' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button></div></div>
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

                <article className={overviewPanelClass('equities', 'overview-equities')}>
                  <div className="panel-heading"><div><p className="eyebrow">STOCKS &amp; ETFS</p><h2>{formatMoney(equities)} total</h2></div><div className="panel-heading-actions"><div className="equity-pnl-strip"><span><small>Unrealized</small><strong className={stockPnl >= 0 ? 'value-positive' : 'value-negative'}>{stockPnl >= 0 ? '+' : ''}{formatMoney(stockPnl)}</strong></span><span><small>Realized</small><strong className={realizedXtb >= 0 ? 'value-positive' : 'value-negative'}>{realizedXtb >= 0 ? '+' : ''}{formatMoney(realizedXtb)}</strong></span></div><button className="panel-expand-button" onClick={() => setExpandedPanel(expandedPanel === 'equities' ? null : 'equities')} aria-label="Expand stocks and ETFs">{expandedPanel === 'equities' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button></div></div>
                  <div className="equity-grid"><AgGridReact<EquityGridRow> theme={portfolioGridTheme} rowData={equityGridRows} columnDefs={equityColumns} defaultColDef={{ sortable: true, resizable: true }} getRowId={({ data }) => data.symbol} rowHeight={34} headerHeight={30} onRowClicked={({ data }) => data && setExpandedEquity(data.symbol)} /></div>
                  <div className="equity-footer"><span>{equityExposure.length} securities · {formatMoney(stockCostBasis)} known cost</span><span>{brokerageTransactions.length ? 'Realized P/L from XTB history' : 'Realized P/L unavailable'}</span></div>
                  {expandedEquity && (() => {
                    const asset = equityExposure.find((item) => item.symbol === expandedEquity)
                    if (!asset) return null
                    const details = [...asset.breakdown.entries()].sort((a, b) => b[1].value - a[1].value)
                    const assetTransactions = brokerageByAsset.get(asset.symbol) || []
                    const assetRealizedRows = assetTransactions.filter((transaction) => transaction.realized_pnl_usd != null)
                    const assetRealizedPnl = assetRealizedRows.reduce((sum, transaction) => sum + Number(transaction.realized_pnl_usd), 0)
                    const assetUnrealizedPnl = asset.pricedValue - asset.pricedCost
                    return <div className="equity-drilldown">
                      <div className="drilldown-head"><span><i /><strong>{asset.symbol} · {asset.name}</strong><small>Position by platform · choose a venue for transaction history</small></span><button onClick={() => setExpandedEquity(null)} aria-label="Close position detail"><X size={14} /></button></div>
                      <div className="equity-drilldown-summary">
                        <span><small>Current value</small><strong>{formatMoney(asset.value)}</strong></span>
                        <span><small>Unrealized P/L</small><strong className={asset.pricedQuantity ? (assetUnrealizedPnl >= 0 ? 'value-positive' : 'value-negative') : ''}>{asset.pricedQuantity ? `${assetUnrealizedPnl >= 0 ? '+' : ''}${formatMoney(assetUnrealizedPnl)}` : '—'}</strong></span>
                        <span><small>Realized P/L</small><strong className={assetRealizedRows.length ? (assetRealizedPnl >= 0 ? 'value-positive' : 'value-negative') : ''}>{assetRealizedRows.length ? `${assetRealizedPnl >= 0 ? '+' : ''}${formatMoney(assetRealizedPnl)}` : '—'}</strong></span>
                      </div>
                      <div className="equity-breakdown-labels"><span>Platform</span><span>Quantity / average</span><span>Value</span><span>Unrealized</span><span>Realized</span><span /></div>
                      <div className="asset-breakdown equity-breakdown">{details.map(([name, detail]) => {
                        const detailPnl = detail.value - detail.costBasis
                        const venueTransactions = assetTransactions.filter((transaction) => transaction.account && platformIdentity(transaction.account) === name)
                        const venueRealizedRows = venueTransactions.filter((transaction) => transaction.realized_pnl_usd != null)
                        const venueRealizedPnl = venueRealizedRows.reduce((sum, transaction) => sum + Number(transaction.realized_pnl_usd), 0)
                        return <button key={name} onClick={() => venueTransactions.length && setSelectedBrokerDetail({ symbol: asset.symbol, venue: name })} disabled={!venueTransactions.length}>
                          <span>{name}<small>{venueTransactions.length ? `${venueTransactions.length} transactions · click to open` : 'Position detail only'}</small></span>
                          <span className="equity-quantity"><strong>{formatAmount(detail.quantity)} shares</strong><small>{detail.costBasis ? `Avg ${formatMoneyCents(detail.costBasis / detail.quantity)}` : 'Average cost pending'}</small></span>
                          <b>{formatMoney(detail.value)}</b>
                          <em className={detail.costBasis ? (detailPnl >= 0 ? 'value-positive' : 'value-negative') : ''}>{detail.costBasis ? `${detailPnl >= 0 ? '+' : ''}${formatMoney(detailPnl)}` : '—'}</em>
                          <em className={venueRealizedRows.length ? (venueRealizedPnl >= 0 ? 'value-positive' : 'value-negative') : ''}>{venueRealizedRows.length ? `${venueRealizedPnl >= 0 ? '+' : ''}${formatMoney(venueRealizedPnl)}` : '—'}</em>
                          <ChevronRight size={12} />
                        </button>
                      })}</div>
                    </div>
                  })()}
                  {selectedBrokerDetail && <div className={`broker-drilldown ${brokerFullscreen ? 'fullscreen' : ''}`}><div className="drilldown-head"><span><i /><strong>{selectedBrokerDetail.symbol} · {selectedBrokerDetail.venue}</strong><small>{displayedBuyCount} buys · {displayedSellCount} sells · realized <b className={displayedRealizedPnl >= 0 ? 'value-positive' : 'value-negative'}>{displayedRealizedPnl >= 0 ? '+' : ''}{formatMoney(displayedRealizedPnl)}</b></small></span><div className="drilldown-actions"><button onClick={() => setBrokerFullscreen((value) => !value)} aria-label={brokerFullscreen ? 'Exit full screen' : 'Maximize transaction history'} title={brokerFullscreen ? 'Exit full screen' : 'Maximize'}>{brokerFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button><button onClick={() => { setSelectedBrokerDetail(null); setBrokerFullscreen(false) }} aria-label="Close transaction history"><X size={14} /></button></div></div><div className="broker-grid"><AgGridReact<TransactionGridRow> theme={portfolioGridTheme} rowData={transactionGridRows} columnDefs={transactionColumns} defaultColDef={{ sortable: true, resizable: true, floatingFilter: true }} getRowId={({ data }) => data.id} rowHeight={34} headerHeight={31} floatingFiltersHeight={29} /></div></div>}
                </article>

                <aside className={overviewPanelClass('spending', 'overview-spending')}>
                  <div className="panel-heading"><div><p className="eyebrow">CARD ACCOUNTS</p><h2>Balances &amp; activity</h2></div><div className="panel-heading-actions"><button className="panel-expand-button" onClick={() => setExpandedPanel(expandedPanel === 'spending' ? null : 'spending')} aria-label="Expand card activity">{expandedPanel === 'spending' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button></div></div>
                  <div className="month-selector"><button onClick={() => shiftSpendMonth(-1)} disabled={spendMonth <= minSpendMonth} aria-label="Previous month"><ChevronLeft size={13} /></button><strong>{selectedMonthLabel}</strong><button onClick={() => shiftSpendMonth(1)} disabled={spendMonth >= maxSpendMonth} aria-label="Next month"><ChevronRight size={13} /></button></div>
                  <div className="source-toggles">{[{ key: 'ether.fi', label: 'Ether.fi' }, { key: 'kast', label: 'KAST' }, { key: 'ethena', label: 'Ethena' }].map((source) => <label key={source.key}><input type="checkbox" checked={selectedCardSources.includes(source.key)} onChange={() => toggleCardSource(source.key)} /><span>{source.label}</span></label>)}</div>
                  <div className="activity-type-toggles">{[{ key: 'purchase', label: 'Transactions' }, { key: 'refund', label: 'Refunds' }, { key: 'cashback', label: 'Cashback' }].map((type) => <label key={type.key}><input type="checkbox" checked={selectedActivityTypes.includes(type.key)} onChange={() => toggleActivityType(type.key)} /><span>{type.label}</span></label>)}</div>
                  <div className="card-activity-summary"><div><span>Current balance</span><strong>{formatMoneyCents(cardBalanceTotal)}</strong></div><div><span>Cleared spend</span><strong>{formatMoneyCents(recentSpendTotal)}</strong></div><div><span>Refunds</span><strong className="value-positive">+{formatMoneyCents(recentRefundTotal)}</strong></div><div><span>Cashback</span><strong className="value-positive">+{formatMoneyCents(recentCashbackTotal)}</strong></div></div>
                  <div className="spend-section"><div className="spend-section-title"><span>Balances</span><small>{cardBalances.length}</small></div><div className="balance-list">{cardBalances.map((position) => <div key={position.id}><span><strong>{position.asset.symbol}</strong><small>{formatAmount(Number(position.quantity))} units · {position.account.name} · as of {new Date(position.as_of).toLocaleDateString()}</small></span><b>{formatMoney(Number(position.value_usd))}</b></div>)}</div></div>
                  <div className="spend-section activity-section unified-activity"><div className="spend-section-title"><span>Transaction events</span><small>{visibleCardActivity.length}</small></div><div className="recent-spend-list">{visibleCardActivity.map((transaction) => {
                    const cashback = spendCashback(transaction)
                    const transactionUrl = spendTransactionUrl(transaction)
                    const isRefund = transaction.transaction_type === 'refund'
                    const isCashback = transaction.transaction_type === 'cashback'
                    const label = isRefund ? 'Refund' : isCashback ? 'Cashback' : 'Tx'
                    const merchant = transaction.merchant || transaction.description || (isRefund ? 'Card refund' : isCashback ? 'Standalone cashback' : 'Card transaction')
                    return <div key={transaction.id}>
                      <span><strong>{merchant}</strong><small><i className={`tx-type ${transaction.transaction_type}`}>{label}</i>{transaction.source} · {new Date(transaction.occurred_at).toLocaleDateString()}{transactionUrl && <a href={transactionUrl} target="_blank" rel="noreferrer" aria-label="Open transaction on explorer">Tx <ExternalLink size={8} /></a>}</small>{!isCashback && cashback > 0 && <em className="tx-cashback">+{formatMoneyCents(cashback)} cashback</em>}</span>
                      <b className={isRefund || isCashback ? 'value-positive' : 'value-negative'}>{isRefund || isCashback ? '+' : '-'}{formatMoneyCents(Math.abs(Number(transaction.amount_usd)))}</b>
                    </div>
                  })}{!visibleCardActivity.length && <p className="activity-empty">No matching events for this month.</p>}</div></div>
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
                  <div className="panel-heading"><div><p className="eyebrow">WEEKLY ADDRESS SNAPSHOTS</p><h2>Crypto wealth over time</h2></div><div className="history-chart-actions"><span>{latestRangeCryptoPoint ? `${formatMoney(latestRangeCryptoPoint.total)} · ${chartCryptoHistory.length} points` : 'Pending'}</span><div className="history-filter-row"><label>Address / platform<select value={selectedCryptoPlatform} onChange={(event) => setSelectedCryptoPlatform(event.target.value)}><option value="all">All addresses / platforms</option>{cryptoPlatforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label><div className="range-toggle" aria-label="Crypto chart range">{cryptoRanges.map((range) => <button key={range} className={cryptoRange === range ? 'active' : ''} onClick={() => setCryptoRange(range)}>{range}</button>)}</div></div></div></div>
                  {chartCryptoHistory.length ? <div className="history-chart"><div className="history-chart-scroll"><div className="history-chart-canvas"><ResponsiveContainer width="100%" height="100%"><AreaChart data={cryptoChartData} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}><defs><linearGradient id="cryptoArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#68d3a0" stopOpacity={0.32} /><stop offset="1" stopColor="#68d3a0" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#1e252b" vertical={false} /><XAxis dataKey="date" minTickGap={42} tick={{ fill: '#5d6971', fontSize: 8 }} tickLine={false} axisLine={false} /><YAxis width={58} domain={['auto', 'auto']} tickFormatter={(value) => formatCompactMoney(Number(value))} tick={{ fill: '#5d6971', fontSize: 8 }} tickLine={false} axisLine={false} /><Tooltip formatter={(value) => [formatMoney(Number(value)), 'Wealth']} contentStyle={{ background: '#11171c', border: '1px solid #2a333a', borderRadius: 7, fontSize: 10 }} labelStyle={{ color: '#8d999f' }} /><Area type="monotone" dataKey="value" stroke="#68d3a0" strokeWidth={2} fill="url(#cryptoArea)" dot={false} activeDot={{ r: 4, fill: '#0d1216', stroke: '#68d3a0' }} /><Brush dataKey="date" height={24} travellerWidth={8} stroke="#315b47" fill="#0d1216" tickFormatter={(date) => String(date).slice(0, 7)} /></AreaChart></ResponsiveContainer></div></div></div> : <div className="history-empty"><Coins size={24} /><strong>Historical backfill not loaded yet</strong><p>The first observed snapshot is available after a successful sync. Reconstructed weekly history from 2018 requires an indexed historical-balance API.</p></div>}
                </article>

                <article className="panel history-address-panel">
                  <div className="panel-heading"><div><p className="eyebrow">{selectedCryptoPlatform === 'all' ? 'ADDRESS / PLATFORM' : 'ASSET / NETWORK'}</p><h2>Latest composition</h2></div><span>{formatMoney(cryptoCompositionTotal)}</span></div>
                  <div className="history-address-list">{cryptoPlatformRows.map((row) => { const delta = row.value - row.start; return <div key={row.platform}><span><strong>{row.platform}</strong><small>{cryptoCompositionTotal ? ((row.value / cryptoCompositionTotal) * 100).toFixed(1) : '0.0'}%{row.quantity == null ? ' of digital wealth' : ` · ${formatAmount(row.quantity)} units`}</small></span><b>{formatMoney(row.value)}</b><em className={delta >= 0 ? 'value-positive' : 'value-negative'}>{delta >= 0 ? '+' : ''}{formatMoney(delta)}</em></div> })}</div>
                </article>

                <article className="panel history-method-panel">
                  <div><p className="eyebrow">VALUATION METHOD</p><h2>Observed vs reconstructed</h2></div>
                  <p><strong>Observed</strong> snapshots use the balances and USD prices returned during each weekly sync. They are the source of truth going forward.</p>
                  <p><strong>Reconstructed</strong> history uses historical balances at each weekly block plus that asset’s USD price on the same date. Chain observations are combined into Tuesday-to-Monday week buckets so a chain-only zero never appears as the wallet’s total. It will be labelled separately because DeFi receipt tokens and unsupported protocols may not reconstruct perfectly.</p>
                  <span>Only positions worth at least $100 on that historical date are retained in the backfill.</span>
                </article>
              </div>
            </section>
          )}

          {view === 'losses' && (
            <section className="losses-page">
              <div className="loss-kpis">
                <article><span>Estimated historical losses</span><strong className="value-negative">{lossTotalLow === lossTotalHigh ? `-${formatMoney(lossTotalLow)}` : `-${formatMoney(lossTotalLow)} to -${formatMoney(lossTotalHigh)}`}</strong><small>Do not subtract again from current net worth</small></article>
                <article><span>Realized</span><strong className="value-negative">-{formatMoney(realizedLoss)}</strong><small>Confirmed or user-reported closed losses</small></article>
                <article><span>Unrealized / mixed</span><strong className="value-negative">-{formatMoney(unrealizedLoss)}</strong><small>Current impairment and unresolved incidents</small></article>
                <article><span>Pending reconciliation</span><strong>{pendingLossEvents}</strong><small>Events missing cost, date, or final outcome</small></article>
              </div>
              <article className="panel losses-panel">
                <div className="panel-heading"><div><p className="eyebrow">EVENT LEDGER</p><h2>Loss events and valuation dates</h2></div><span>{lossEvents.length} events</span></div>
                <div className="losses-grid"><AgGridReact<LossEvent> theme={portfolioGridTheme} rowData={lossEvents} columnDefs={lossColumns} defaultColDef={{ sortable: true, resizable: true, floatingFilter: true }} getRowId={({ data }) => data.id} rowHeight={52} headerHeight={34} floatingFiltersHeight={30} /></div>
              </article>
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
