import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FileText, RefreshCw, Upload } from 'lucide-react'
import { supabase } from './lib/supabase'
import { RiskPage, isRiskAnalysis } from './RiskPage'
import type { Position } from './types'
import './reports.css'

type Column = { key: string; label: string; format?: 'money' | 'percent' | 'number' | 'text' }
type Report = { version: number; key: string; title: string; created_at: string; kind: 'risk' | 'table' | 'review' | 'pdf'; summary: string; sections?: Array<{ title: string; text: string }>; table?: { columns: Column[]; rows: Array<Record<string, string | number | null>> }; pdf_base64?: string; analysis?: Record<string, unknown> }
type Manifest = { key: string; title: string; created_at: string; kind: Report['kind']; summary: string; has_pdf: boolean; row_count: number; risk_summary?: { value: number; volatility: number; monthly_var95: number; monthly_es95: number } }
type Entry = { id: string; manifest: Manifest }
const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const manifest = (r: Report): Manifest => ({ key: r.key, title: r.title, created_at: r.created_at, kind: r.kind, summary: r.summary, has_pdf: Boolean(r.pdf_base64), row_count: r.table?.rows.length || 0, ...(r.kind === 'risk' && r.analysis ? { risk_summary: { value: Number(r.analysis.model_marked_value_usd), volatility: Number(r.analysis.annualized_market_vol_pct), monthly_var95: Number((r.analysis.metrics as Record<string, Record<string, number>>)?.['21']?.loss_95_usd), monthly_es95: Number((r.analysis.metrics as Record<string, Record<string, number>>)?.['21']?.expected_shortfall_95_usd) } } : {}) })
function validReport(r: unknown): r is Report {
  if (!r || typeof r !== 'object') return false
  const v = r as Report
  return v.version === 1 && typeof v.key === 'string' && /^[a-z0-9-]{1,90}$/.test(v.key) && typeof v.title === 'string' && v.title.length <= 160 && typeof v.summary === 'string' && v.summary.length <= 2000 && Number.isFinite(Date.parse(v.created_at)) && ['risk', 'table', 'review', 'pdf'].includes(v.kind)
    && (!v.pdf_base64 || typeof v.pdf_base64 === 'string' && v.pdf_base64.length < 3000000 && /^[A-Za-z0-9+/=\r\n]+$/.test(v.pdf_base64) && atob(v.pdf_base64.slice(0, 12)).startsWith('%PDF-'))
    && (!v.sections || Array.isArray(v.sections) && v.sections.every((s) => typeof s.title === 'string' && typeof s.text === 'string'))
    && (!v.table || Array.isArray(v.table.columns) && v.table.columns.length <= 30 && v.table.columns.every((c) => typeof c.key === 'string' && typeof c.label === 'string') && Array.isArray(v.table.rows) && v.table.rows.length <= 10000 && v.table.rows.every((row) => row && typeof row === 'object' && Object.values(row).every((cell) => cell == null || typeof cell === 'string' || typeof cell === 'number' && Number.isFinite(cell))))
    && (v.kind !== 'risk' || isRiskAnalysis(v.analysis))
}
function PdfViewer({ base64, title }: { base64: string; title: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)); const next = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); setUrl(next)
    return () => { URL.revokeObjectURL(next); setUrl('') }
  }, [base64])
  return <div className="report-pdf">{url && <><p><a href={url} target="_blank" rel="noopener noreferrer">Open full document</a><span>Use this if your phone does not display the embedded viewer.</span></p><iframe src={`${url}#view=FitH`} title={title} /></>}</div>
}
function ReportTable({ table }: { table: NonNullable<Report['table']> }) {
  const [query, setQuery] = useState(''); const [order, setOrder] = useState<{ key: string; asc: boolean } | null>(null)
  const rows = useMemo(() => {
    const out = table.rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(query.toLowerCase())))
    if (order) out.sort((a, b) => { const x = a[order.key], y = b[order.key]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * (order.asc ? 1 : -1) })
    return out
  }, [table, query, order])
  function cell(v: string | number | null, f?: Column['format']) { return v == null ? '—' : typeof v === 'number' ? f === 'money' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(v) < 100 ? 3 : 2 }).format(v) : f === 'percent' ? `${v.toFixed(1)}%` : new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(v) : v }
  return <article className="panel"><div className="report-table-search"><label>Search this report<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a position or value" /></label><span>{rows.length} rows · tap a column to sort</span></div><div className="table-scroll"><table className="dense-table report-table"><thead><tr>{table.columns.map((c) => <th key={c.key} scope="col" aria-sort={order?.key === c.key ? order.asc ? 'ascending' : 'descending' : 'none'}><button onClick={() => setOrder({ key: c.key, asc: order?.key === c.key ? !order.asc : true })}>{c.label}{order?.key === c.key ? order.asc ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{table.columns.map((c) => <td key={c.key}>{cell(r[c.key], c.format)}</td>)}</tr>)}</tbody></table></div></article>
}
export function ReportsPage({ positions, positionsLoading, currentTotal, userId }: { positions: Position[]; positionsLoading: boolean; currentTotal: number; userId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]); const [selected, setSelected] = useState<string | null>(null); const [report, setReport] = useState<Report | null>(null); const [busy, setBusy] = useState(true); const [error, setError] = useState(''); const [status, setStatus] = useState(''); const [refresh, setRefresh] = useState(0); const [search, setSearch] = useState(''); const [tab, setTab] = useState('analysis'); const [comparison, setComparison] = useState(''); const [importing, setImporting] = useState(false); const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const controller = new AbortController(); let cancelled = false; const timer = window.setTimeout(() => controller.abort(), 20000); setBusy(true); setError('')
    void (async () => { try { const result = await supabase.from('assets').select('id,manifest:metadata->report_manifest').eq('symbol', '_PORTFOLIO_REPORT').order('created_at', { ascending: false }).limit(200).abortSignal(controller.signal); if (result.error) throw result.error; if (!cancelled) setEntries((result.data || []).filter((x) => x.manifest && typeof x.manifest === 'object' && typeof (x.manifest as Record<string, unknown>).title === 'string' && typeof (x.manifest as Record<string, unknown>).created_at === 'string' && typeof (x.manifest as Record<string, unknown>).summary === 'string') as unknown as Entry[]) } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load reports.') } finally { window.clearTimeout(timer); if (!cancelled) setBusy(false) } })()
    return () => { cancelled = true; window.clearTimeout(timer); controller.abort() }
  }, [refresh])
  useEffect(() => {
    if (!selected) { setReport(null); return }
    const controller = new AbortController(); let cancelled = false; const timer = window.setTimeout(() => controller.abort(), 25000); setBusy(true); setError(''); setReport(null)
    void (async () => { try { const result = await supabase.from('assets').select('report:metadata->report').eq('id', selected).eq('symbol', '_PORTFOLIO_REPORT').abortSignal(controller.signal).single(); if (result.error) throw result.error; if (!validReport(result.data.report)) throw new Error('This report has an unsupported format.'); if (!cancelled) { setReport(result.data.report); setTab(result.data.report.kind === 'pdf' ? 'document' : 'analysis') } } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to open report.') } finally { window.clearTimeout(timer); if (!cancelled) setBusy(false) } })()
    return () => { cancelled = true; window.clearTimeout(timer); controller.abort() }
  }, [selected])
  async function importFile(file: File) {
    setImporting(true); setError(''); setStatus('')
    try {
      if (file.size > 10000000) throw new Error('Choose a report bundle smaller than 10 MB.')
      let reports: Report[]
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        if (file.size > 2000000) throw new Error('PDF reports must be smaller than 2 MB.')
        const bytes = new Uint8Array(await file.arrayBuffer()); if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('This file is not a valid PDF.')
        let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
        reports = [{ version: 1, key: `pdf-${crypto.randomUUID()}`, title: file.name.replace(/\.pdf$/i, '').slice(0, 160), created_at: new Date().toISOString(), kind: 'pdf', summary: 'Uploaded report', pdf_base64: btoa(binary) }]
      } else { const bundle = JSON.parse(await file.text()); reports = bundle.version === 1 && Array.isArray(bundle.reports) ? bundle.reports : [bundle] }
      if (!reports.length || reports.length > 50 || !reports.every(validReport)) throw new Error('The report bundle is incomplete or unsupported.')
      const owned = await supabase.from('assets').select('id').eq('owner_id', userId).limit(1); if (owned.error) throw owned.error; if (!owned.data?.length) throw new Error('Report upload is available to the portfolio owner.')
      let saved = 0
      for (const item of reports) {
        const network = `report:${item.key}`; const existing = await supabase.from('assets').select('id').eq('owner_id', userId).eq('symbol', '_PORTFOLIO_REPORT').eq('network', network).maybeSingle(); if (existing.error) throw existing.error
        const metadata = { report_manifest: manifest(item), report: item }; const result = existing.data ? await supabase.from('assets').update({ metadata }).eq('id', existing.data.id).eq('owner_id', userId) : await supabase.from('assets').insert({ owner_id: userId, symbol: '_PORTFOLIO_REPORT', name: item.title, network, asset_class: 'alternative', currency: 'USD', metadata }); if (result.error) throw result.error; saved++
        if (item.kind === 'risk' && item.analysis) {
          const cache = await supabase.from('assets').select('id,analysis:metadata->analysis').eq('owner_id', userId).eq('symbol', '_RISK_ANALYSIS_CACHE').eq('network', 'risk-analysis:v1').maybeSingle(); if (cache.error) throw cache.error
          const cached = cache.data?.analysis as { created_at_utc?: string } | null
          if (!cached?.created_at_utc || cached.created_at_utc <= String(item.analysis.created_at_utc)) {
            const metadata = { analysis: item.analysis, published_at_utc: new Date().toISOString() }
            const write = cache.data ? await supabase.from('assets').update({ metadata }).eq('id', cache.data.id).eq('owner_id', userId) : await supabase.from('assets').insert({ owner_id: userId, symbol: '_RISK_ANALYSIS_CACHE', name: 'Private portfolio risk analysis', asset_class: 'alternative', currency: 'USD', network: 'risk-analysis:v1', metadata }); if (write.error) throw write.error
          }
        }
      }
      setStatus(`${saved} report${saved === 1 ? '' : 's'} saved. Open any report below.`); setSelected(null); setRefresh((v) => v + 1)
    } catch (e) { setError(`${e instanceof Error ? e.message : 'Unable to save reports.'} Any reports saved before the error remain available; importing the bundle again updates matching reports.`) } finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const visible = entries.filter((e) => `${e.manifest.title} ${e.manifest.summary}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at))
  const compareEntry = entries.find((e) => e.id === comparison); const currentEntry = entries.find((e) => e.id === selected)
  return <section className="reports-page"><div className="reports-toolbar">{selected ? <button className="secondary-button" onClick={() => { setSelected(null); setComparison('') }}><ArrowLeft size={15} />All reports</button> : <label className="reports-search">Find report<input type="search" placeholder="Search reports" value={search} onChange={(e) => setSearch(e.target.value)} /></label>}<div><button className="secondary-button" onClick={() => setRefresh((v) => v + 1)} disabled={busy}><RefreshCw size={14} />Refresh library</button><button className="secondary-button" onClick={() => fileRef.current?.click()} disabled={importing}><Upload size={14} />{importing ? 'Saving…' : 'Upload report'}</button><input ref={fileRef} type="file" accept="application/json,.json,application/pdf,.pdf" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file) }} /></div></div>
    {error && <p className="form-message error" role="alert">{error}</p>}{status && <p className="form-message" role="status">{status}</p>}
    {!selected && <><p className="reports-help">Reports are private to the approved dashboard audience. Opening a report displays it here; downloading is optional. Each report keeps its original analysis date.</p>{busy ? <p role="status">Loading reports…</p> : !visible.length ? <article className="panel reports-empty"><FileText size={26} /><h2>{entries.length ? 'No matching reports' : 'Your report library is ready'}</h2><p>{entries.length ? 'Try a different search.' : 'Saved reports will appear here. The owner can upload a PDF or a prepared report bundle using the button above.'}</p></article> : <div className="reports-grid">{visible.map((e) => <button className="report-card" key={e.id} onClick={() => { setSelected(e.id); setComparison('') }}><div><FileText size={19} /><small>{new Date(e.manifest.created_at).toLocaleDateString()}</small></div><strong>{e.manifest.title}</strong><p>{e.manifest.summary}</p><span>{e.manifest.kind === 'risk' ? 'Interactive risk analysis' : e.manifest.row_count ? `${e.manifest.row_count} searchable rows` : 'Report'}{e.manifest.has_pdf ? ' · PDF viewer' : ''}</span></button>)}</div>}</>}
    {selected && busy && !report && <p role="status">Opening report…</p>}
    {report && <><header className="report-header"><p className="eyebrow">SAVED REPORT · {new Date(report.created_at).toLocaleDateString()}</p><h2>{report.title}</h2><p>{report.summary}</p><div className="report-tabs" role="group" aria-label="Report view">{report.kind !== 'pdf' && <button className={tab === 'analysis' ? 'active' : ''} aria-pressed={tab === 'analysis'} onClick={() => setTab('analysis')}>Analysis</button>}{report.table && <button className={tab === 'table' ? 'active' : ''} aria-pressed={tab === 'table'} onClick={() => setTab('table')}>Data table</button>}{report.pdf_base64 && <button className={tab === 'document' ? 'active' : ''} aria-pressed={tab === 'document'} onClick={() => setTab('document')}>Full report</button>}</div></header>
    {report.kind === 'risk' && currentEntry?.manifest.risk_summary && <article className="panel report-compare"><label>Compare with another risk report<select value={comparison} onChange={(e) => setComparison(e.target.value)}><option value="">Choose a saved analysis</option>{entries.filter((e) => e.id !== selected && e.manifest.risk_summary).map((e) => <option key={e.id} value={e.id}>{e.manifest.title}</option>)}</select></label>{compareEntry?.manifest.risk_summary && <div className="table-scroll"><table className="dense-table"><thead><tr><th>Metric</th><th>This report</th><th>Comparison</th></tr></thead><tbody>{([['value', 'Portfolio value'], ['volatility', 'Annual market volatility'], ['monthly_var95', 'Monthly 95% loss threshold'], ['monthly_es95', 'Monthly worst-5% average loss']] as const).map(([key, label]) => <tr key={key}><td>{label}</td><td>{key === 'volatility' ? `${currentEntry.manifest.risk_summary![key].toFixed(1)}%` : usd(currentEntry.manifest.risk_summary![key])}</td><td>{key === 'volatility' ? `${compareEntry.manifest.risk_summary![key].toFixed(1)}%` : usd(compareEntry.manifest.risk_summary![key])}</td></tr>)}</tbody></table><p>Different holdings, prices and model windows can change these figures; comparison alone does not prove performance improved.</p></div>}</article>}
    {tab === 'analysis' && (report.kind === 'risk' ? <RiskPage positions={positions} positionsLoading={positionsLoading} currentTotal={currentTotal} refreshToken={0} reportAssetId={selected!} /> : <div className="report-sections">{report.sections?.map((s, i) => <article key={i} className="panel"><h3>{s.title}</h3><p>{s.text}</p></article>)}{!report.sections?.length && report.table && <ReportTable key={report.key} table={report.table} />}</div>)}
    {tab === 'table' && report.table && <ReportTable key={report.key} table={report.table} />}{tab === 'document' && report.pdf_base64 && <PdfViewer base64={report.pdf_base64} title={report.title} />}</>}
  </section>
}
