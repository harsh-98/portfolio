import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X } from 'lucide-react'
import { supabase } from './lib/supabase'

const RECORD = '_INVESTMENT_THESIS'
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const dateLabel = (date: string | null) => date ? new Date(`${date}T12:00:00`).toLocaleDateString() : 'Not set'
type Thesis = { version: number; ticker: string; body: string; added_on: string; prove_by: string | null; author: string }
type Entry = { id: string; owner_id: string; created_at: string; updated_at: string; metadata: Record<string, unknown> & { thesis: Thesis } }
const snapshot = (body: string, added: string, deadline: string) => JSON.stringify([body, added, deadline])
const fail = (e: unknown) => e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String(e.message) : 'Please try again.'

export default function ThesisEditor({ symbol, session, onClose }: { symbol: string; session: Session; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const userId = session.user.id
  const author = String(session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Member').slice(0, 60)
  const network = `thesis:${encodeURIComponent(symbol)}`
  const [entries, setEntries] = useState<Entry[]>([])
  const [selectedOwner, setSelectedOwner] = useState(userId)
  const [body, setBody] = useState('')
  const [added, setAdded] = useState(today)
  const [deadline, setDeadline] = useState('')
  const [baseline, setBaseline] = useState(snapshot('', today(), ''))
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [discard, setDiscard] = useState(false)
  const ownEntry = entries.find((entry) => entry.owner_id === userId)
  const ownView = selectedOwner === userId
  const selected = entries.find((entry) => entry.owner_id === selectedOwner)
  const dirty = snapshot(body, added, deadline) !== baseline

  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 15000)
    let active = true
    setLoading(true); setLoadFailed(false); setError('')
    void (async () => {
      try {
        const result = await supabase.from('assets').select('id,owner_id,created_at,updated_at,metadata').eq('symbol', RECORD).eq('network', network).order('created_at').limit(50).abortSignal(controller.signal)
        if (result.error) throw result.error
        if (!active) return
        const rows = (result.data || []).filter((row) => {
          const doc = row.metadata?.thesis
          return doc?.version === 1 && doc.ticker === symbol && typeof doc.body === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.added_on) && (doc.prove_by == null || /^\d{4}-\d{2}-\d{2}$/.test(doc.prove_by))
        }) as Entry[]
        setEntries(rows)
        const own = rows.find((row) => row.owner_id === userId)?.metadata.thesis
        const text = own?.body || '', start = own?.added_on || today(), end = own?.prove_by || ''
        setBody(text); setAdded(start); setDeadline(end); setBaseline(snapshot(text, start, end))
      } catch (e) { if (active) { setLoadFailed(true); setError(`Unable to load thesis. ${fail(e)}`) } }
      finally { window.clearTimeout(timer); if (active) setLoading(false) }
    })()
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [network, symbol, userId, reload])

  function requestClose() {
    if (busy) return
    if (dirty) { setDiscard(true); return }
    onClose()
  }
  async function save() {
    if (busy || loading || loadFailed || !ownView) return
    if (!body.trim()) { setError('Write your thesis before saving.'); return }
    if (!added || (deadline && deadline < added)) { setError('Choose an added date and a prove-by date on or after it.'); return }
    setBusy(true); setError(''); setSaved(false)
    try {
      const thesis: Thesis = { version: 1, ticker: symbol, body, added_on: added, prove_by: deadline || null, author }
      const metadata = { ...ownEntry?.metadata, thesis }
      const fields = 'id,owner_id,created_at,updated_at,metadata'
      const result = ownEntry
        ? await supabase.from('assets').update({ metadata }).eq('id', ownEntry.id).eq('owner_id', userId).eq('updated_at', ownEntry.updated_at).select(fields).abortSignal(AbortSignal.timeout(15000)).maybeSingle()
        : await supabase.from('assets').insert({ owner_id: userId, symbol: RECORD, name: `${symbol} investment thesis`, asset_class: 'alternative', currency: 'USD', network, metadata }).select(fields).abortSignal(AbortSignal.timeout(15000)).single()
      if (result.error) throw result.error
      if (!result.data) throw new Error('This thesis changed elsewhere. Copy your draft and reopen it to load the latest version.')
      const entry = result.data as Entry
      setEntries((old) => [...old.filter((row) => row.owner_id !== userId), entry])
      setBaseline(snapshot(body, added, deadline)); setSaved(true)
    } catch (e) { setError(`Unable to save thesis. ${fail(e)}`) }
    finally { setBusy(false) }
  }
  const visibleBody = ownView ? body : selected?.metadata.thesis.body || ''
  const visibleAdded = ownView ? added : selected?.metadata.thesis.added_on || ''
  const visibleDeadline = ownView ? deadline : selected?.metadata.thesis.prove_by || ''
  return <dialog ref={dialog} className="thesis-dialog" aria-labelledby="thesis-title" onCancel={(event) => { event.preventDefault(); requestClose() }}>
    <header className="thesis-header"><div><small>INVESTMENT THESIS</small><h2 id="thesis-title">{symbol} / thesis</h2></div><button type="button" onClick={requestClose} disabled={busy} aria-label="Close thesis"><X size={18} /></button></header>
    {loading ? <p role="status">Loading thesis…</p> : <>
      {entries.some((entry) => entry.owner_id !== userId) && <label className="thesis-owner">Thesis by<select value={selectedOwner} onChange={(event) => setSelectedOwner(event.target.value)}><option value={userId}>You</option>{entries.filter((entry) => entry.owner_id !== userId).map((entry) => <option key={entry.id} value={entry.owner_id}>{entry.metadata.thesis.author || 'Member'}</option>)}</select></label>}
      {ownView ? <div className="thesis-dates"><label>Added on<input type="date" value={added} disabled={busy || loadFailed} onChange={(event) => { setAdded(event.target.value); setSaved(false) }} required /></label><label>Prove by<input type="date" value={deadline} min={added || undefined} disabled={busy || loadFailed} onChange={(event) => { setDeadline(event.target.value); setSaved(false) }} /></label></div> : <div className="thesis-dates"><p>Added on <b>{dateLabel(visibleAdded)}</b></p><p>Prove by <b>{dateLabel(visibleDeadline)}</b></p></div>}
      {visibleDeadline && <p className={visibleDeadline < today() ? 'thesis-overdue' : 'thesis-deadline'}>{visibleDeadline < today() ? 'Review overdue' : visibleDeadline === today() ? 'Review due today' : 'Review by'} · {dateLabel(visibleDeadline)}</p>}
      {ownView && <div className="thesis-tabs"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write Markdown</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></div>}
      {ownView && !preview ? <label className="thesis-body-label">Your thesis<textarea value={body} maxLength={30000} disabled={busy || loadFailed} onChange={(event) => { setBody(event.target.value); setSaved(false) }} placeholder={'## Why I own this\n\n- Key assumptions\n- What would prove the thesis\n- What would invalidate it'} /><small>Markdown supports headings, links, lists, tables, and checklists.</small></label> : <article className="thesis-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span>{alt || 'Image'}</span> }}>{visibleBody || '*No thesis written yet.*'}</Markdown></article>}
      <footer className="thesis-footer"><small>{selected?.updated_at ? `Last saved ${new Date(selected.updated_at).toLocaleString()}` : 'Not saved yet'}{dirty && ownView ? ' · Unsaved changes' : ''}</small>{ownView && <button type="button" disabled={busy || loadFailed || !body.trim() || (!dirty && !!ownEntry)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save thesis'}</button>}</footer>
      {saved && <p className="thesis-saved" role="status">Thesis saved.</p>}
    </>}
    {error && <p className="thesis-error" role="alert">{error}{loadFailed && <button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button>}</p>}
    {discard && <div className="thesis-discard" role="alert"><span>Discard your unsaved changes?</span><button type="button" onClick={onClose}>Discard</button><button type="button" onClick={() => setDiscard(false)}>Keep editing</button></div>}
  </dialog>
}
