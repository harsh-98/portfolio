import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
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

type View = 'overview' | 'holdings' | 'activity'

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
  return normalized
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

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [positionsResult, accountsResult, snapshotsResult, positionSnapshotsResult, syncRunsResult, brokerageResult, spendResult] = await Promise.all([
      supabase.from('positions').select('*, account:accounts(*), asset:assets(*)').order('value_usd', { ascending: false }),
      supabase.from('accounts').select('*').order('name'),
      supabase.from('portfolio_snapshots').select('*').order('snapshot_date', { ascending: true }).limit(90),
      supabase.from('position_snapshots').select('snapshot_date,source_key,value_usd').order('snapshot_date', { ascending: false }).limit(2000),
      supabase.from('sync_runs').select('id,source,status,records_written,message,started_at,finished_at').order('started_at', { ascending: false }).limit(20),
      supabase.from('brokerage_transactions').select('id,event_time,event_type,amount_usd,realized_pnl_usd').order('event_time', { ascending: false }).limit(1000),
      supabase.from('spend_transactions').select('id,source,occurred_at,merchant,description,amount_usd,category,status').order('occurred_at', { ascending: false }).limit(1000),
    ])
    const failure = positionsResult.error || accountsResult.error || snapshotsResult.error || positionSnapshotsResult.error || syncRunsResult.error || brokerageResult.error || spendResult.error
    if (failure) setError(failure.message)
    setPositions((positionsResult.data || []) as unknown as Position[])
    setAccounts((accountsResult.data || []) as Account[])
    setSnapshots((snapshotsResult.data || []) as Snapshot[])
    setPositionSnapshots((positionSnapshotsResult.data || []) as PositionSnapshot[])
    setSyncRuns((syncRunsResult.data || []) as SyncRun[])
    setBrokerageTransactions((brokerageResult.data || []) as BrokerageTransaction[])
    setSpendTransactions((spendResult.data || []) as SpendTransaction[])
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const total = useMemo(() => positions.reduce((sum, position) => sum + Number(position.value_usd), 0), [positions])
  const allocation = useMemo(() => {
    const grouped = new Map<string, number>()
    positions.forEach((position) => grouped.set(position.asset.asset_class, (grouped.get(position.asset.asset_class) || 0) + Number(position.value_usd)))
    return Object.entries(classMeta)
      .map(([key, meta]) => ({ key, ...meta, value: grouped.get(key) || 0 }))
      .filter((item) => item.value > 0)
  }, [positions])
  const liquid = allocation.filter((item) => ['cash', 'stablecoin'].includes(item.key)).reduce((sum, item) => sum + item.value, 0)
  const equities = allocation.find((item) => item.key === 'equity')?.value || 0
  const crypto = allocation.filter((item) => ['crypto', 'nft'].includes(item.key)).reduce((sum, item) => sum + item.value, 0)
  const sourceTotals = useMemo(() => {
    const grouped = new Map<string, number>()
    positions.forEach((position) => grouped.set(position.account.institution || position.account.name, (grouped.get(position.account.institution || position.account.name) || 0) + Number(position.value_usd)))
    return [...grouped.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [positions])
  const priorPositionValues = useMemo(() => {
    const dates = [...new Set(positionSnapshots.map((snapshot) => snapshot.snapshot_date))].sort().reverse()
    const priorDate = dates.find((date) => date < new Date().toISOString().slice(0, 10))
    return new Map(positionSnapshots.filter((snapshot) => snapshot.snapshot_date === priorDate).map((snapshot) => [snapshot.source_key, Number(snapshot.value_usd)]))
  }, [positionSnapshots])
  const walletChains = useMemo(() => {
    const grouped = new Map<string, { wallet: string; chain: string; value: number; previous: number }>()
    positions.filter((position) => position.account.institution === 'Rabby').forEach((position) => {
      const key = position.account.name
      const current = grouped.get(key) || { wallet: position.account.name.split(' · ')[0], chain: position.asset.network || position.account.name.split(' · ')[1] || 'Unknown', value: 0, previous: 0 }
      current.value += Number(position.value_usd)
      current.previous += priorPositionValues.get(position.source_key) || 0
      grouped.set(key, current)
    })
    return [...grouped.values()].sort((a, b) => b.value - a.value)
  }, [positions, priorPositionValues])
  const equityPositions = positions.filter((position) => position.asset.asset_class === 'equity')
  const cryptoExposure = useMemo(() => {
    const grouped = new Map<string, { symbol: string; name: string; value: number; quantity: number; venues: Set<string>; networks: Set<string>; assetClass: AssetClass }>()
    positions.filter((position) => ['crypto', 'stablecoin'].includes(position.asset.asset_class)).forEach((position) => {
      const symbol = canonicalCryptoSymbol(position.asset.symbol)
      const current = grouped.get(symbol) || { symbol, name: position.asset.name, value: 0, quantity: 0, venues: new Set<string>(), networks: new Set<string>(), assetClass: position.asset.asset_class }
      current.value += Number(position.value_usd)
      current.quantity += Number(position.quantity)
      current.venues.add(position.account.institution || position.account.name)
      if (position.asset.network) current.networks.add(position.asset.network)
      grouped.set(symbol, current)
    })
    return [...grouped.values()].filter((item) => item.value >= 100).sort((a, b) => b.value - a.value)
  }, [positions])
  const brokerageAllocation = useMemo(() => {
    const grouped = new Map<string, number>()
    equityPositions.forEach((position) => grouped.set(position.account.institution || position.account.name, (grouped.get(position.account.institution || position.account.name) || 0) + Number(position.value_usd)))
    return [...grouped.entries()].map(([name, value]) => ({ name, value, percent: equities ? (value / equities) * 100 : 0 })).sort((a, b) => b.value - a.value)
  }, [equities, equityPositions])
  const realizedXtb = brokerageTransactions.reduce((sum, transaction) => sum + Number(transaction.realized_pnl_usd || 0), 0)
  const recentSpend = spendTransactions.filter((transaction) => new Date(transaction.occurred_at).getTime() >= Date.now() - 30 * 86_400_000)
  const recentSpendTotal = recentSpend.reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount_usd)), 0)
  const spendBySource = [...recentSpend.reduce((grouped, transaction) => grouped.set(transaction.source, (grouped.get(transaction.source) || 0) + Math.abs(Number(transaction.amount_usd))), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])
  const pendingSpends = spendTransactions.filter((transaction) => transaction.status?.toLowerCase() === 'pending')
  const pendingRuns = syncRuns.filter((run) => ['running', 'partial'].includes(run.status))
  const pendingCount = pendingSpends.length + pendingRuns.length
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

  const navItems: Array<{ id: View; label: string; icon: typeof BarChart3 }> = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
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

        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">{view === 'overview' ? 'PRIVATE WEALTH SYSTEM' : view.toUpperCase()}</p><h1>{view === 'overview' ? 'Your network' : view === 'holdings' ? 'All holdings' : 'Portfolio activity'}</h1></div>
            <div className="heading-actions"><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spinning' : ''} />Refresh</button><button className="primary-button compact" onClick={() => setShowHoldingForm(true)}><Plus size={17} />Add holding</button></div>
          </div>

          {error && <div className="error-banner"><ShieldCheck size={18} /><span>{error}</span></div>}

          {view === 'overview' && (
            <>
              <section className="network-summary">
                <article className="net-worth-card"><span>Net worth</span><strong>{loading ? '—' : formatMoney(total)}</strong><p className={previous && change < 0 ? 'negative' : 'positive'}>{previous ? (change >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />) : <ShieldCheck size={14} />}{snapshotMessage}</p><small>Updated {positions[0]?.as_of ? new Date(positions[0].as_of).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</small></article>
                <article className="summary-cell"><span>Liquid</span><strong>{formatMoney(liquid)}</strong><small>{total ? `${((liquid / total) * 100).toFixed(1)}% of portfolio` : '—'}</small></article>
                <article className="summary-cell"><span>Invested</span><strong>{formatMoney(total - liquid)}</strong><small>{equityPositions.length + cryptoExposure.length} tracked exposures</small></article>
                <article className={`summary-cell pending-cell ${pendingCount ? 'has-pending' : ''}`}><span>Pending</span><strong>{pendingCount}</strong><small>{pendingCount ? `${pendingSpends.length} cards · ${pendingRuns.length} syncs` : 'Nothing needs attention'}</small></article>
              </section>

              <section className="network-grid">
                <article className="panel platform-panel">
                  <div className="panel-heading"><div><p className="eyebrow">YOUR NETWORK</p><h2>Platforms</h2></div><span>{sourceTotals.length} sources</span></div>
                  <div className="platform-grid">{sourceTotals.map((source) => <div key={source.name}><span>{source.name}</span><strong>{formatMoney(source.value)}</strong><small>{total ? ((source.value / total) * 100).toFixed(1) : '0.0'}%</small></div>)}</div>
                </article>

                <article className="panel allocation-mini">
                  <div className="panel-heading"><div><p className="eyebrow">ALLOCATION</p><h2>Asset mix</h2></div><span>Live</span></div>
                  <div className="allocation-bar">{allocation.map((item) => <i key={item.key} style={{ width: `${total ? (item.value / total) * 100 : 0}%`, background: item.color }} />)}</div>
                  <div className="allocation-compact">{allocation.map((item) => <div key={item.key}><span><i style={{ background: item.color }} />{item.label}</span><strong>{total ? ((item.value / total) * 100).toFixed(1) : '0.0'}%</strong></div>)}</div>
                </article>

                <article className="panel brokerage-panel">
                  <div className="panel-heading"><div><p className="eyebrow">STOCKS BY VENUE</p><h2>Brokerage split</h2></div><span>{formatMoney(equities)}</span></div>
                  <div className="broker-bars">{brokerageAllocation.map((broker) => <div key={broker.name}><div><strong>{broker.name}</strong><span>{formatMoney(broker.value)} · {broker.percent.toFixed(1)}%</span></div><i><b style={{ width: `${broker.percent}%` }} /></i></div>)}</div>
                </article>

                <article className="panel crypto-panel full-span">
                  <div className="panel-heading"><div><p className="eyebrow">EXPOSURE ABOVE $100</p><h2>Digital assets</h2></div><span>{cryptoExposure.length} assets</span></div>
                  {cryptoExposure.length ? <div className="table-scroll"><table className="dense-table"><thead><tr><th>Asset</th><th>Exposure</th><th>Quantity</th><th>Venues</th><th>Networks</th><th>% of digital</th></tr></thead><tbody>{cryptoExposure.map((asset) => <tr key={asset.symbol}><td><div className="table-asset"><span className="asset-badge">{asset.symbol.slice(0, 3)}</span><div><strong>{asset.symbol}</strong><small>{asset.name}</small></div></div></td><td><strong>{formatMoney(asset.value)}</strong></td><td>{formatAmount(asset.quantity)}</td><td>{[...asset.venues].join(', ')}</td><td>{[...asset.networks].join(', ') || '—'}</td><td>{crypto ? ((asset.value / crypto) * 100).toFixed(1) : '0.0'}%</td></tr>)}</tbody></table></div> : <div className="inline-empty">No digital-asset exposure above $100.</div>}
                  <p className="panel-note">Rabby’s last refresh is still an aggregate, so unsupported self-custody tokens remain under the unclassified wallet position until the rate limit clears.</p>
                </article>

                <article className="panel equity-panel full-span">
                  <div className="panel-heading"><div><p className="eyebrow">CURRENT POSITIONS</p><h2>Stocks and ETFs</h2></div><span>{brokerageTransactions.length ? `${formatMoney(realizedXtb)} XTB realized` : `${equityPositions.length} positions`}</span></div>
                  {equityPositions.length ? <div className="table-scroll"><table className="dense-table"><thead><tr><th>Asset</th><th>Venue</th><th>Quantity</th><th>Cost basis</th><th>Value</th><th>P/L</th><th>% of stocks</th></tr></thead><tbody>{equityPositions.map((position) => { const pnl = position.cost_basis_usd == null ? null : Number(position.value_usd) - Number(position.cost_basis_usd); return <tr key={position.id}><td><strong>{position.asset.symbol}</strong><small>{position.asset.name}</small></td><td>{position.account.institution}</td><td>{formatAmount(position.quantity)}</td><td>{position.cost_basis_usd == null ? '—' : formatMoney(position.cost_basis_usd)}</td><td><strong>{formatMoney(position.value_usd)}</strong></td><td className={pnl && pnl > 0 ? 'value-positive' : pnl && pnl < 0 ? 'value-negative' : ''}>{pnl == null ? '—' : formatMoney(pnl)}</td><td>{equities ? ((Number(position.value_usd) / equities) * 100).toFixed(1) : '0.0'}%</td></tr> })}</tbody></table></div> : <div className="inline-empty">No equity positions.</div>}
                </article>

                <article className="panel chain-panel full-span">
                  <div className="panel-heading"><div><p className="eyebrow">WALLET → CHAIN</p><h2>On-chain network</h2></div><span>{walletChains.length} networks</span></div>
                  {walletChains.length ? <div className="table-scroll"><table className="dense-table"><thead><tr><th>Wallet</th><th>Chain</th><th>Current value</th><th>Since prior snapshot</th><th>Portfolio weight</th></tr></thead><tbody>{walletChains.map((row) => { const delta = row.previous ? row.value - row.previous : 0; return <tr key={`${row.wallet}:${row.chain}`}><td><strong>{row.wallet}</strong></td><td>{row.chain}</td><td><strong>{formatMoney(row.value)}</strong></td><td className={delta > 0 ? 'value-positive' : delta < 0 ? 'value-negative' : ''}>{row.previous ? `${delta >= 0 ? '+' : ''}${formatMoney(delta)}` : 'Baseline only'}</td><td>{total ? ((row.value / total) * 100).toFixed(2) : '0.00'}%</td></tr> })}</tbody></table></div> : <div className="inline-empty">Chain-level wallet detail is pending the next successful Rabby refresh. The self-custody total is still included in net worth.</div>}
                </article>

                {spendTransactions.length > 0 && <article className="panel full-span">
                  <div className="panel-heading"><div><p className="eyebrow">LAST 30 DAYS</p><h2>Card spending · {formatMoney(recentSpendTotal)}</h2></div><span>{recentSpend.length} transactions</span></div>
                  <div className="spend-layout"><div className="dense-list">{spendBySource.map(([source, value]) => <div key={source}><strong>{source}</strong><span>{formatMoney(value)}</span></div>)}</div><div className="recent-spend">{recentSpend.slice(0, 6).map((transaction) => <div key={transaction.id}><span><strong>{transaction.merchant || transaction.description || 'Card transaction'}</strong><small>{transaction.source} · {new Date(transaction.occurred_at).toLocaleDateString()}</small></span><strong>{formatMoney(Math.abs(Number(transaction.amount_usd)))}</strong></div>)}</div></div>
                </article>}
              </section>
            </>
          )}

          {view === 'holdings' && (
            <section className="panel holdings-panel">
              <div className="table-tools"><label><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search assets or accounts" /></label><span>{filteredPositions.length} positions</span></div>
              {positions.length ? (
                <div className="table-scroll"><table><thead><tr><th>Asset</th><th>Account</th><th>Class</th><th>Quantity</th><th>Price</th><th>Value</th><th>Weight</th></tr></thead><tbody>{filteredPositions.map((position) => <tr key={position.id}><td><div className="table-asset"><span className="asset-badge">{position.asset.symbol.slice(0, 3)}</span><div><strong>{position.asset.symbol}</strong><small>{position.asset.name}</small></div></div></td><td><strong>{position.account.name}</strong><small>{position.account.institution}</small></td><td><span className="class-pill"><i style={{ background: classMeta[position.asset.asset_class].color }} />{classMeta[position.asset.asset_class].label}</span></td><td>{formatAmount(position.quantity)}</td><td>{formatMoney(position.price_usd)}</td><td><strong>{formatMoney(position.value_usd)}</strong></td><td>{total ? ((position.value_usd / total) * 100).toFixed(2) : '0.00'}%</td></tr>)}</tbody></table></div>
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
