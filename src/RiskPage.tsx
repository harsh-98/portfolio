import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, ShieldCheck } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { supabase } from './lib/supabase'
import type { Position } from './types'
import './risk.css'

type Horizon = '21' | '63' | '252'
type RiskMetric = { loss_95_usd: number; loss_95_pct: number; loss_99_usd: number; loss_99_pct: number; expected_shortfall_95_usd: number; expected_shortfall_95_pct: number }
type RiskRow = { symbol: string; value_usd: number; portfolio_weight_pct: number; annualized_standalone_vol_pct: number; one_month_ES95_contribution_usd: number; one_month_ES95_contribution_pct: number; economic_category: string; risk_note: string }
type RiskAnalysis = {
  version: number
  created_at_utc: string
  model_marked_value_usd: number
  recorded_supabase_total_usd: number
  annualized_market_vol_pct: number
  paths: number
  history_start: string
  history_end: string
  joint_daily_observations: number
  metrics: Record<Horizon, RiskMetric>
  rows: RiskRow[]
  groups: Array<{ name: string; weight: number; risk: number }>
  histogram: Record<Horizon, Array<{ loss_pct: number; scenarios_pct: number }>>
  stresses: Record<string, { loss_usd: number; loss_pct: number }>
  whatifs: Record<string, RiskMetric>
  baseline_positions: Array<{ id: string; quantity: number }>
  limitations: string[]
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const percent = (n: number) => `${n.toFixed(1)}%`
const horizons: Array<{ id: Horizon; label: string }> = [{ id: '21', label: '1 month' }, { id: '63', label: '3 months' }, { id: '252', label: '1 year' }]
const stressLabels: Record<string, string> = {
  risk_off: 'Crypto −40%, stocks −20%, gold −10%; calls written off',
  severe_risk_off: 'Crypto −60%, stocks −35%, gold −15%; calls written off',
  risk_off_plus_10pct_stablecoin_loss: 'Risk-off scenario plus stablecoins −10%',
  USDT_10pct_haircut_only: 'USDT loses 10% of its value',
  USDT_total_failure_only: 'USDT becomes worthless',
}

function isAnalysis(value: unknown): value is RiskAnalysis {
  if (!value || typeof value !== 'object') return false
  const a = value as RiskAnalysis
  return a.version === 1 && Number.isFinite(a.model_marked_value_usd) && a.model_marked_value_usd > 0 && Number.isFinite(a.annualized_market_vol_pct)
    && Array.isArray(a.rows) && Array.isArray(a.groups) && Array.isArray(a.baseline_positions) && Array.isArray(a.limitations)
    && !!a.stresses && !!a.whatifs && Number.isFinite(a.whatifs.move_50k_ETH_15k_HYPE_to_Treasuries?.loss_95_usd) && Number.isFinite(a.whatifs.move_50k_ETH_to_VOO?.loss_95_usd)
    && a.rows.every((r) => typeof r.symbol === 'string' && [r.value_usd, r.portfolio_weight_pct, r.annualized_standalone_vol_pct, r.one_month_ES95_contribution_pct, r.one_month_ES95_contribution_usd].every(Number.isFinite))
    && a.groups.every((r) => typeof r.name === 'string' && Number.isFinite(r.weight) && Number.isFinite(r.risk))
    && Number.isFinite(Date.parse(a.created_at_utc)) && Number.isFinite(a.paths) && Number.isFinite(a.joint_daily_observations)
    && horizons.every(({ id }) => Number.isFinite(a.metrics?.[id]?.loss_95_usd) && Number.isFinite(a.metrics[id].expected_shortfall_95_usd) && Array.isArray(a.histogram?.[id]))
}

export function RiskPage({ positions, positionsLoading, currentTotal, refreshToken }: { positions: Position[]; positionsLoading: boolean; currentTotal: number; refreshToken: number }) {
  const [analysis, setAnalysis] = useState<RiskAnalysis | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [horizon, setHorizon] = useState<Horizon>('21')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'risk' | 'volatility' | 'value'>('risk')
  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 20000)
    setBusy(true)
    setError('')
    let cancelled = false
    void (async () => {
      try {
        const result = await supabase.from('assets').select('analysis:metadata->analysis').eq('symbol', '_RISK_ANALYSIS_CACHE').eq('network', 'risk-analysis:v1').abortSignal(controller.signal).maybeSingle()
        if (cancelled) return
        if (result.error) throw result.error
        if (!result.data) { setAnalysis(null); return }
        const value = result.data.analysis
        if (!isAnalysis(value)) throw new Error('The saved analysis is incomplete. Please publish a new risk analysis.')
        setAnalysis(value)
      } catch (failure) {
        if (!cancelled) setError(controller.signal.aborted ? 'Risk analysis took too long to load. Tap Refresh to retry.' : failure instanceof Error ? failure.message : 'Unable to load the risk analysis.')
      } finally {
        window.clearTimeout(timeout)
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort() }
  }, [refreshToken])

  const changedHoldings = useMemo(() => {
    if (!analysis || positionsLoading) return null
    const baseline = new Map(analysis.baseline_positions.map((p) => [p.id, Number(p.quantity)]))
    return positions.length !== baseline.size || positions.some((p) => !baseline.has(p.id) || Math.abs(Number(p.quantity) - baseline.get(p.id)!) > Math.max(1e-8, Math.abs(Number(p.quantity)) * 1e-9))
  }, [analysis, positions, positionsLoading])
  const rows = useMemo(() => analysis?.rows.filter((r) => r.symbol.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => sort === 'value' ? b.value_usd - a.value_usd : sort === 'volatility' ? b.annualized_standalone_vol_pct - a.annualized_standalone_vol_pct : b.one_month_ES95_contribution_pct - a.one_month_ES95_contribution_pct) || [], [analysis, search, sort])

  function downloadCsv() {
    if (!analysis) return
    const quote = (value: string | number) => {
      const text = typeof value === 'string' && /^[=+@\t\r-]/.test(value) ? `'${value}` : String(value)
      return `"${text.replaceAll('"', '""')}"`
    }
    const lines = [['Position', 'Analysis value USD', 'Portfolio weight %', 'Annual volatility %', 'Monthly ES95 contribution USD', 'Monthly ES95 contribution %', 'Notes'].map(quote).join(','), ...analysis.rows.map((r) => [r.symbol, r.value_usd, r.portfolio_weight_pct, r.annualized_standalone_vol_pct, r.one_month_ES95_contribution_usd, r.one_month_ES95_contribution_pct, r.risk_note].map(quote).join(','))]
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `portfolio-risk-${analysis.created_at_utc.slice(0, 10)}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (busy && !analysis) return <div className="panel risk-message" role="status">Loading saved risk analysis…</div>
  if (!analysis) return <div className="panel risk-message" role="status">{error || 'No risk analysis has been published yet.'}</div>
  const metric = analysis.metrics[horizon]
  const modelAge = Math.max(0, Math.floor((Date.now() - Date.parse(analysis.created_at_utc)) / 86400000))
  const move = positionsLoading ? null : currentTotal - analysis.model_marked_value_usd
  return <section className="risk-page" aria-label="Portfolio risk analysis">
    {error && <div className="risk-notice risk-warning" role="alert"><AlertTriangle size={16} /><span>{error} The previously loaded analysis remains below.</span></div>}
    <div className={`risk-notice ${changedHoldings || modelAge >= 7 ? 'risk-warning' : ''}`} role="status"><ShieldCheck size={17} /><div><strong>Saved analysis · {new Date(analysis.created_at_utc).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</strong><span>{changedHoldings === null ? 'Checking current holdings…' : changedHoldings ? 'Holdings have changed since this simulation. A new analysis is needed.' : 'Recorded quantities match this analysis.'} {modelAge >= 7 ? `Analysis is ${modelAge} days old. ` : ''}Price refreshes do not rerun the simulation.{move != null && Math.abs(move) >= 1 ? ` Current portfolio value differs by ${move >= 0 ? '+' : '−'}${money(Math.abs(move))}.` : ''}</span></div></div>
    <div className="risk-controls"><div className="risk-horizons" role="group" aria-label="Simulation horizon">{horizons.map((h) => <button key={h.id} className={horizon === h.id ? 'active' : ''} aria-pressed={horizon === h.id} onClick={() => setHorizon(h.id)}>{h.label}</button>)}</div><span>{analysis.paths.toLocaleString()} simulated scenarios{busy ? ' · refreshing saved analysis…' : ''}</span></div>
    <div className="risk-kpis" aria-live="polite"><article><span>Analysis portfolio value</span><strong>{money(analysis.model_marked_value_usd)}</strong><small>Fixed holdings and market marks at analysis time</small></article><article><span>95% loss threshold</span><strong className="value-negative">{money(metric.loss_95_usd)}</strong><small>{percent(metric.loss_95_pct)} · worse in 5% of simulated periods</small></article><article><span>Average of worst 5% losses</span><strong className="value-negative">{money(metric.expected_shortfall_95_usd)}</strong><small>{percent(metric.expected_shortfall_95_pct)} · expected shortfall</small></article><article><span>Annual market volatility</span><strong>{percent(analysis.annualized_market_vol_pct)}</strong><small>Historical variability, not a predicted loss</small></article></div>
    <div className="risk-notice"><AlertTriangle size={16} /><span>These are historical model scenarios, not guaranteed probabilities or maximum losses. Stablecoin depegs, hacks, custody and wrapper failures are assessed separately below.</span></div>
    <div className="risk-chart-grid"><article className="panel"><div className="panel-heading"><div><p className="eyebrow">CONCENTRATION</p><h2>Value versus loss contribution</h2></div></div><p className="risk-caption">Share of portfolio value versus share of the worst 5% of one-month losses. The contribution chart always uses one month.</p><div className="risk-chart" role="img" aria-label="Grouped portfolio value and one-month expected-shortfall shares; exact per-position figures are in the table below."><ResponsiveContainer width="100%" height="100%"><BarChart layout="vertical" data={analysis.groups.slice(0, 9)} margin={{ left: 0, right: 14, bottom: 8 }}><CartesianGrid stroke="#263139" horizontal={false} /><XAxis type="number" tickFormatter={(v) => `${v}%`} tick={{ fill: '#8d9ba5', fontSize: 10 }} /><YAxis type="category" dataKey="name" width={114} tick={{ fill: '#bbc6cd', fontSize: 10 }} /><Tooltip contentStyle={{ background: '#11191f', border: '1px solid #34414b' }} formatter={(value) => percent(Number(value))} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="weight" name="Portfolio value %" fill="#6a9cbd" radius={[0, 3, 3, 0]} /><Bar dataKey="risk" name="Monthly loss contribution %" fill="#d58270" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div></article>
    <article className="panel"><div className="panel-heading"><div><p className="eyebrow">MONTE CARLO</p><h2>Simulated loss distribution</h2></div></div><p className="risk-caption">{horizons.find((h) => h.id === horizon)?.label} · horizontal axis is loss as a percentage of portfolio value; negative means a gain.</p><div className="risk-chart" role="img" aria-label={`${horizons.find((h) => h.id === horizon)?.label} simulated loss distribution. 95% loss threshold ${percent(metric.loss_95_pct)}, 99% threshold ${percent(metric.loss_99_pct)}.`}><ResponsiveContainer width="100%" height="100%"><BarChart data={analysis.histogram[horizon]} margin={{ right: 12, left: 0, bottom: 8 }}><CartesianGrid stroke="#263139" vertical={false} /><XAxis dataKey="loss_pct" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} tick={{ fill: '#8d9ba5', fontSize: 10 }} /><YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: '#8d9ba5', fontSize: 10 }} width={42} /><Tooltip contentStyle={{ background: '#11191f', border: '1px solid #34414b' }} labelFormatter={(value) => `Loss: ${Number(value).toFixed(1)}%`} formatter={(value) => [`${Number(value).toFixed(2)}%`, 'Scenarios in this bin']} /><ReferenceLine x={metric.loss_95_pct} stroke="#df8b76" strokeDasharray="4 3" /><Bar dataKey="scenarios_pct" name="Scenarios" fill="#6a9cbd" /></BarChart></ResponsiveContainer></div><p className="risk-caption">Dashed line: 95% loss threshold. 99% threshold: {money(metric.loss_99_usd)} ({percent(metric.loss_99_pct)}).</p></article></div>
    <article className="panel"><div className="panel-heading"><div><p className="eyebrow">EVERY POSITION</p><h2>Compare risk contributions</h2></div><button className="secondary-button" onClick={downloadCsv}><Download size={14} />CSV</button></div><div className="risk-table-controls"><label>Find position<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Symbol" /></label><label>Sort by<select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="risk">Monthly loss contribution</option><option value="volatility">Individual volatility</option><option value="value">Position value</option></select></label></div><p className="risk-caption">Position contributions always use one month. Annual volatility measures individual variability; loss contribution also reflects position size and correlations. Zero model price risk does not mean risk-free.</p><div className="table-scroll"><table className="dense-table risk-table"><thead><tr><th scope="col">Position</th><th scope="col">Analysis value</th><th scope="col">Weight</th><th scope="col">Annual vol.</th><th scope="col">Monthly loss share</th><th scope="col">Monthly loss contribution</th></tr></thead><tbody>{rows.map((r) => <tr key={r.symbol}><td title={r.risk_note}><strong>{r.symbol}</strong><small>{r.economic_category === 'option' ? 'Option · delta approximation' : r.economic_category === 'stablecoin' ? 'Depeg / issuer risk separate' : r.economic_category === 'cash' ? 'Cash · currency risk where applicable' : r.economic_category === 'treasury' ? 'Treasury ETF' : ''}</small></td><td>{money(r.value_usd)}</td><td>{percent(r.portfolio_weight_pct)}</td><td>{percent(r.annualized_standalone_vol_pct)}</td><td>{percent(r.one_month_ES95_contribution_pct)}</td><td>{money(r.one_month_ES95_contribution_usd)}</td></tr>)}</tbody></table>{!rows.length && <p className="risk-caption">No matching positions.</p>}</div></article>
    <div className="risk-chart-grid"><article className="panel"><div className="panel-heading"><div><p className="eyebrow">BEYOND HISTORICAL PRICES</p><h2>Stress scenarios</h2></div></div><p className="risk-caption">Hypothetical shocks with no probability or time horizon assigned. Scenarios are independent and should not be added together.</p><div className="risk-scenarios">{Object.entries(analysis.stresses).map(([id, s]) => <div key={id}><span>{stressLabels[id] || id}</span><strong className="value-negative">−{money(s.loss_usd)}<small>{percent(s.loss_pct)}</small></strong></div>)}</div></article><article className="panel"><div className="panel-heading"><div><p className="eyebrow">ALLOCATION COMPARISON</p><h2>What could reduce risk?</h2></div></div><p className="risk-caption">One-month 95% loss threshold under identical scenarios. These are comparisons, not trades.</p><div className="risk-scenarios"><div><span>Current analysed allocation</span><strong>{money(analysis.metrics['21'].loss_95_usd)}</strong></div><div><span>Move $50k ETH + $15k HYPE to short Treasuries</span><strong>{money(analysis.whatifs.move_50k_ETH_15k_HYPE_to_Treasuries.loss_95_usd)}</strong></div><div><span>Move $50k ETH to VOO</span><strong>{money(analysis.whatifs.move_50k_ETH_to_VOO.loss_95_usd)}</strong></div></div></article></div>
    <article className="panel risk-method"><div className="panel-heading"><div><p className="eyebrow">ASSUMPTIONS & COVERAGE</p><h2>How to read this analysis</h2></div></div><p>{analysis.joint_daily_observations} joint daily observations · {analysis.history_start} to {analysis.history_end}. Five-day historical blocks are sampled together across assets to preserve correlations. The model assumes no average one-day arithmetic price growth, fixed holdings and no interest, fees or taxes. Options use a fixed-volatility pricing approximation with expiry payoffs; FX is included. Crypto trades every day, while stock-market dates are used for alignment.</p><p>Market data: Yahoo Finance; HYPE uses Hyperliquid perpetual candles as a spot-return proxy. Some small tokens and wrapped assets use disclosed underlying proxies. A new simulation is required after material holdings or market-regime changes.</p><details><summary>Model limitations</summary><ul>{analysis.limitations.filter((line) => !line.includes('tests')).map((line) => <li key={line}>{line}</li>)}</ul></details></article>
  </section>
}
