import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  CircleDollarSign,
  Landmark,
  Layers3,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  WalletCards,
  X,
} from 'lucide-react'
import { isConfigured, supabase } from './lib/supabase'
import type { Account, AssetClass, Position, Snapshot } from './types'

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

function AllocationDonut({ allocation, total }: { allocation: Array<{ key: string; label: string; value: number; color: string }>; total: number }) {
  const positive = allocation.filter((item) => item.value > 0)
  let cursor = 0
  const stops = positive.map((item) => {
    const start = cursor
    cursor += total ? (item.value / total) * 100 : 0
    return `${item.color} ${start}% ${cursor}%`
  })
  const background = stops.length ? `conic-gradient(${stops.join(', ')})` : 'conic-gradient(#e6e9e5 0 100%)'
  return (
    <div className="allocation-layout">
      <div className="donut" style={{ background }}><div><strong>{formatMoney(total)}</strong><span>Total assets</span></div></div>
      <div className="allocation-legend">
        {allocation.map((item) => (
          <div className="legend-row" key={item.key}>
            <span className="legend-label"><i style={{ background: item.color }} />{item.label}</span>
            <span><strong>{total ? ((item.value / total) * 100).toFixed(1) : '0.0'}%</strong><small>{formatMoney(item.value)}</small></span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Dashboard({ session }: { session: Session }) {
  const [view, setView] = useState<View>('overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [positions, setPositions] = useState<Position[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showHoldingForm, setShowHoldingForm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [positionsResult, accountsResult, snapshotsResult] = await Promise.all([
      supabase.from('positions').select('*, account:accounts(*), asset:assets(*)').order('value_usd', { ascending: false }),
      supabase.from('accounts').select('*').order('name'),
      supabase.from('portfolio_snapshots').select('*').order('snapshot_date', { ascending: true }).limit(90),
    ])
    const failure = positionsResult.error || accountsResult.error || snapshotsResult.error
    if (failure) setError(failure.message)
    setPositions((positionsResult.data || []) as unknown as Position[])
    setAccounts((accountsResult.data || []) as Account[])
    setSnapshots((snapshotsResult.data || []) as Snapshot[])
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
  const alternatives = total - liquid - equities - crypto
  const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2].total_value_usd : null
  const change = previous ? total - previous : 0
  const changePercent = previous ? (change / previous) * 100 : 0
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
        <div className="sidebar-brand"><span><Sparkles size={17} /></span><strong>Northstar</strong><button className="mobile-close" onClick={() => setMobileNav(false)}><X size={19} /></button></div>
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
          <button className="menu-button" onClick={() => setMobileNav(true)}><Menu size={21} /></button>
          <div><span className="status-dot" />Private workspace</div>
          <button className="profile-button"><span>{session.user.email?.slice(0, 1).toUpperCase()}</span><ChevronDown size={15} /></button>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">{view === 'overview' ? 'PORTFOLIO OVERVIEW' : view.toUpperCase()}</p><h1>{view === 'overview' ? 'Your financial position' : view === 'holdings' ? 'All holdings' : 'Portfolio activity'}</h1></div>
            <div className="heading-actions"><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spinning' : ''} />Refresh</button><button className="primary-button compact" onClick={() => setShowHoldingForm(true)}><Plus size={17} />Add holding</button></div>
          </div>

          {error && <div className="error-banner"><ShieldCheck size={18} /><span>{error}</span></div>}

          {view === 'overview' && (
            <>
              <section className="hero-card">
                <div><span>Total net worth</span><strong>{loading ? '—' : formatMoney(total)}</strong><p className={change >= 0 ? 'positive' : 'negative'}>{change >= 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}{previous ? `${formatMoney(Math.abs(change))} (${Math.abs(changePercent).toFixed(2)}%) since last snapshot` : 'First snapshot pending'}</p></div>
                <div className="hero-aside"><span>Last refreshed</span><strong>{positions[0]?.as_of ? new Date(positions[0].as_of).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'No data yet'}</strong><small>{accounts.length} connected accounts</small></div>
              </section>

              <section className="metric-grid">
                {[
                  { label: 'Liquid reserves', value: liquid, icon: CircleDollarSign, note: 'Cash + stablecoins', tone: 'green' },
                  { label: 'Public equities', value: equities, icon: Landmark, note: total ? `${((equities / total) * 100).toFixed(1)}% of portfolio` : 'No positions', tone: 'orange' },
                  { label: 'Digital assets', value: crypto, icon: WalletCards, note: total ? `${((crypto / total) * 100).toFixed(1)}% of portfolio` : 'No positions', tone: 'purple' },
                  { label: 'Other assets', value: alternatives, icon: Layers3, note: 'Fixed income, gold + other', tone: 'blue' },
                ].map((metric) => {
                  const Icon = metric.icon
                  return <article className="metric-card" key={metric.label}><div className={`icon-tile ${metric.tone}`}><Icon size={20} /></div><span>{metric.label}</span><strong>{formatMoney(metric.value)}</strong><small>{metric.note}</small></article>
                })}
              </section>

              <section className="content-grid">
                <article className="panel allocation-panel">
                  <div className="panel-heading"><div><p className="eyebrow">COMPOSITION</p><h2>Asset allocation</h2></div><span>Live</span></div>
                  {allocation.length ? <AllocationDonut allocation={allocation} total={total} /> : <EmptyState compact />}
                </article>
                <article className="panel">
                  <div className="panel-heading"><div><p className="eyebrow">LARGEST POSITIONS</p><h2>Top holdings</h2></div><button onClick={() => chooseView('holdings')}>View all</button></div>
                  {positions.length ? <div className="top-holdings">{positions.slice(0, 5).map((position, index) => <div key={position.id}><span className="rank">{String(index + 1).padStart(2, '0')}</span><span className="asset-badge">{position.asset.symbol.slice(0, 3)}</span><div><strong>{position.asset.name}</strong><small>{position.account.name}</small></div><span className="holding-value"><strong>{formatMoney(position.value_usd)}</strong><small>{total ? ((position.value_usd / total) * 100).toFixed(1) : 0}%</small></span></div>)}</div> : <EmptyState compact />}
                </article>
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
            <section className="panel activity-panel">
              <div className="timeline-mark"><Activity size={22} /></div>
              <p className="eyebrow">AUDIT TRAIL</p><h2>Sync history is ready</h2><p>Every automatic refresh and manual import will appear here after the data adapters are connected.</p>
              <div className="activity-stub"><span /><div><strong>Supabase workspace connected</strong><small>Authentication and row-level access are configured by the project migration.</small></div></div>
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
