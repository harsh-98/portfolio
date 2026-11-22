import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Session } from '@supabase/supabase-js'
import { MessageCircle, Pencil, Pin, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { supabase } from './lib/supabase'
import './chat.css'

// Metadata-only records use the existing approved-user read / owner-write policies.
// There are no positions for these records, so they never enter portfolio totals.
const MESSAGE = '_PORTFOLIO_CHAT'
const PIN = '_PORTFOLIO_CHAT_PIN'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Message = { id: string; owner_id: string; created_at: string; updated_at: string; edited_at: string | null; body: string; author: string; metadata: Record<string, unknown> }
type GoalPin = { id: string; owner_id: string; messageId: string; author: string }
type Row = { id: string; owner_id: string; created_at: string; updated_at: string; metadata: Record<string, unknown> }
const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 60) : 'Member'
const failure = (error: unknown) => error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Please try again.'
function parseMessage(row: Row): Message | null {
  const chat = row.metadata.chat as { body?: unknown; author?: unknown; edited_at?: unknown } | undefined
  if (!chat || typeof chat.body !== 'string' || !chat.body.trim()) return null
  return { id: row.id, owner_id: row.owner_id, created_at: row.created_at, updated_at: row.updated_at, body: chat.body.slice(0, 2000), author: label(chat.author), metadata: row.metadata,
    edited_at: typeof chat.edited_at === 'string' && Number.isFinite(Date.parse(chat.edited_at)) ? chat.edited_at : null }
}


export function PortfolioChat({ session, goalsHost }: { session: Session; goalsHost: HTMLElement | null }) {
  const userId = session.user.id
  const author = label(session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Member')
  const [open, setOpen] = useState(false)
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null)
  const goalMenu = useRef<HTMLDetailsElement>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [pins, setPins] = useState<GoalPin[]>([])
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ message: Message; text: string } | null>(null)
  const [editError, setEditError] = useState('')
  const editRevision = useRef(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [limit, setLimit] = useState(50)
  const [hasOlder, setHasOlder] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)
  const launcher = useRef<HTMLButtonElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const firstLoad = useRef(true)
  const newestSeen = useRef('')
  const loaded = useRef(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const openRef = useRef(open)
  openRef.current = open

  const load = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    const revision = editRevision.current
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const [recent, savedPins] = await Promise.all([
        supabase.from('assets').select('id,owner_id,created_at,updated_at,metadata').eq('symbol', MESSAGE).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1).abortSignal(controller.signal),
        supabase.from('assets').select('id,owner_id,created_at,updated_at,metadata').eq('symbol', PIN).order('created_at', { ascending: false }).limit(1000).abortSignal(controller.signal),
      ])
      if (recent.error) throw recent.error
      if (savedPins.error) throw savedPins.error
      const goals: GoalPin[] = (savedPins.data || []).flatMap((row: Row) => {
        const pin = row.metadata.chat_pin as { message_id?: unknown; author?: unknown } | undefined
        return pin && typeof pin.message_id === 'string' && uuid.test(pin.message_id) ? [{ id: row.id, owner_id: row.owner_id, messageId: pin.message_id, author: label(pin.author) }] : []
      })
      const rows = (recent.data || []).slice(0, limit) as Row[]
      const missing = [...new Set(goals.map((p) => p.messageId))].filter((id) => !rows.some((m) => m.id === id))
      // Keep older goals visible even when the conversation has moved on.
      for (let i = 0; i < missing.length; i += 100) {
        const older = await supabase.from('assets').select('id,owner_id,created_at,updated_at,metadata').eq('symbol', MESSAGE).in('id', missing.slice(i, i + 100)).abortSignal(controller.signal)
        if (older.error) throw older.error
        rows.push(...(older.data || []) as Row[])
      }
      const parsed = rows.map(parseMessage).filter((message): message is Message => message !== null)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      if (!mounted.current || revision !== editRevision.current) return
      const latest = parsed.at(-1)?.created_at || ''
      if (loaded.current && !openRef.current) setUnread(parsed.filter((m) => m.owner_id !== userId && m.created_at > newestSeen.current).length)
      if (!loaded.current || openRef.current) { newestSeen.current = latest; setUnread(0) }
      loaded.current = true
      setMessages(parsed); setPins(goals); setHasOlder((recent.data?.length || 0) > limit)
      setError('')
    } catch (e) {
      if (mounted.current) setError(`Chat could not refresh. ${controller.signal.aborted ? 'Connection timed out.' : failure(e)}`)
    } finally {
      window.clearTimeout(timeout)
      pending.current = false
      if (mounted.current) setLoading(false)
    }
  }, [limit, userId])

  useEffect(() => {
    mounted.current = true
    void load()
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, open ? 5000 : 20000)
    const refreshVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', refreshVisible)
    return () => { mounted.current = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', refreshVisible) }
  }, [load, open])

  useEffect(() => {
    if (!open) return
    setUnread(0); newestSeen.current = messages.at(-1)?.created_at || ''
    if (firstLoad.current || nearBottom.current) timeline.current?.scrollTo({ top: timeline.current.scrollHeight })
    if (messages.length) firstLoad.current = false
  }, [messages, open])

  useEffect(() => { if (open) { firstLoad.current = true; composer.current?.focus() } }, [open])
  useEffect(() => {
    if (!open || !selectedGoal) return
    const message = document.getElementById(`chat-${selectedGoal}`)
    message?.scrollIntoView({ block: 'center' })
    message?.focus({ preventScroll: true })
    nearBottom.current = false
    firstLoad.current = false
    setSelectedGoal(null)
  }, [open, selectedGoal])

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (goalMenu.current && !goalMenu.current.contains(event.target as Node)) goalMenu.current.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])

  function close() { setOpen(false); setConfirmDelete(null); launcher.current?.focus() }

  async function send() {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true); setError('')
    try {
      const network = `chat-message:${crypto.randomUUID()}`
      const result = await supabase.from('assets').insert({ owner_id: userId, symbol: MESSAGE, name: 'Shared chat message', asset_class: 'alternative', currency: 'USD', network, metadata: { chat: { version: 1, body, author } } }).select('id').single()
      if (result.error) throw result.error
      setDraft(''); nearBottom.current = true; await load(); composer.current?.focus()
    } catch (e) { setError(`Message was not sent. ${failure(e)}`) }
    finally { setBusy(false) }
  }

  function startEdit(message: Message) {
    if (busy || editing || message.owner_id !== userId) return
    setEditing({ message, text: message.body }); setEditError(''); setConfirmDelete(null)
    nearBottom.current = false
    firstLoad.current = false
  }
  function cancelEdit() { setEditing(null); setEditError('') }
  async function saveEdit() {
    if (!editing || busy || editing.message.owner_id !== userId) return
    const message = editing.message, body = editing.text.trim()
    if (!body || body.length > 2000) return
    if (body === message.body) { cancelEdit(); return }
    setBusy(true); setEditError(''); editRevision.current++
    try {
      const chat = message.metadata.chat as Record<string, unknown>
      const metadata = { ...message.metadata, chat: { ...chat, body, edited_at: new Date().toISOString() } }
      const result = await supabase.from('assets').update({ metadata }).eq('id', message.id).eq('owner_id', userId).eq('symbol', MESSAGE).eq('updated_at', message.updated_at)
        .select('id,owner_id,created_at,updated_at,metadata').abortSignal(AbortSignal.timeout(15000)).maybeSingle()
      if (result.error) throw result.error
      if (!result.data) throw new Error('This message changed or was deleted elsewhere. Your draft is kept; copy it, cancel, and refresh before retrying.')
      const saved = parseMessage(result.data as Row)
      if (!saved) throw new Error('The updated message could not be read. Your draft is kept.')
      editRevision.current++
      setMessages((current) => current.map((row) => row.id === saved.id ? saved : row))
      setEditing(null); setEditError('')
      document.getElementById(`chat-${saved.id}`)?.focus({ preventScroll: true })
    } catch (e) { setEditError(`Message was not updated. ${failure(e)}`) }
    finally { setBusy(false) }
  }

  async function togglePin(message: Message) {
    if (busy) return
    setBusy(true); setError('')
    try {
      const own = pins.find((p) => p.messageId === message.id && p.owner_id === userId)
      const result = own
        ? await supabase.from('assets').delete().eq('id', own.id).eq('owner_id', userId).eq('symbol', PIN).select('id')
        : await supabase.from('assets').insert({ owner_id: userId, symbol: PIN, name: 'Shared chat goal pin', asset_class: 'alternative', currency: 'USD', network: `chat-pin:${message.id}`, metadata: { chat_pin: { version: 1, message_id: message.id, author } } }).select('id')
      if (result.error && result.error.code !== '23505') throw result.error
      if (!result.error && !result.data?.length) throw new Error('The pin changed elsewhere. Refresh and try again.')
      await load()
    } catch (e) { setError(`Goal could not be updated. ${failure(e)}`) }
    finally { setBusy(false) }
  }

  async function remove(message: Message) {
    if (busy || message.owner_id !== userId) return
    setBusy(true); setError('')
    try {
      const result = await supabase.from('assets').delete().eq('id', message.id).eq('owner_id', userId).eq('symbol', MESSAGE).select('id')
      if (result.error) throw result.error
      if (!result.data?.length) throw new Error('The message was already removed. Refresh the chat.')
      // Another member's pin may remain as an orphan, but never displays deleted content.
      setConfirmDelete(null); await load()
    } catch (e) { setError(`Message could not be deleted. ${failure(e)}`) }
    finally { setBusy(false) }
  }

  const goals = messages.filter((m) => pins.some((p) => p.messageId === m.id))
  return <>
    {goalsHost && createPortal(<details className="header-goals" ref={goalMenu} onKeyDown={(event) => { if (event.key === 'Escape' && goalMenu.current) { event.stopPropagation(); goalMenu.current.open = false; goalMenu.current.querySelector('summary')?.focus() } }}>
      <summary aria-label={`Pinned goals, ${goals.length}`}><Pin size={13} /><span>Goals</span><small>{goals.length}</small></summary>
      <section className="header-goals-panel" aria-label="Pinned goals">
        <header><strong>Pinned goals</strong><button type="button" onClick={() => void load()} aria-label="Refresh pinned goals"><RefreshCw size={13} /></button></header>
        {loading && <p>Loading goals…</p>}
        {!loading && !goals.length && <p>Pin a message in the chat to add a shared goal.</p>}
        <div className="header-goals-list">{goals.map((m) => <button type="button" key={m.id} onClick={() => { if (goalMenu.current) goalMenu.current.open = false; setOpen(true); setSelectedGoal(m.id) }}><span>{m.body}</span><small>Pinned by {[...new Set(pins.filter((p) => p.messageId === m.id).map((p) => p.owner_id === userId ? 'you' : p.author))].join(' & ')}</small></button>)}</div>
        {error && <p role="alert">{error}</p>}
      </section>
    </details>, goalsHost)}
    <div className="portfolio-chat">
    {open && <section id="portfolio-chat-panel" className="chat-panel" aria-label="Shared chat" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <header className="chat-header"><div><strong><span aria-hidden="true">#</span> Chat</strong></div><button type="button" onClick={() => void load()} aria-label="Refresh chat" title="Refresh chat"><RefreshCw size={13} /></button><button type="button" onClick={close} aria-label="Close chat"><X size={15} /></button></header>

      <div className="chat-timeline" ref={timeline} role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions" onScroll={() => { const el = timeline.current; if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70 }}>
        {hasOlder && <button type="button" className="chat-older" disabled={busy} onClick={() => { nearBottom.current = false; setLimit((v) => v + 50) }}>Load earlier messages</button>}
        {loading && <p className="chat-empty">Loading conversation…</p>}
        {!loading && !messages.length && <div className="chat-empty"><MessageCircle size={20} /><strong>Just the two of you</strong><p>Say something. Pin a goal.</p></div>}
        {messages.map((m) => {
          const own = m.owner_id === userId
          const ownPin = pins.some((p) => p.messageId === m.id && p.owner_id === userId)
          const pinned = pins.some((p) => p.messageId === m.id)
          return <article id={`chat-${m.id}`} tabIndex={-1} className={`chat-message${own ? ' chat-own' : ''}${editing?.message.id === m.id ? ' chat-editing' : ''}`} key={m.id}>
            <span className="chat-avatar" aria-hidden="true">{(own ? author : m.author).slice(0, 1).toUpperCase()}</span>
            <div className="chat-message-meta"><strong>{own ? 'You' : m.author}</strong><time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString()}>{new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>{m.edited_at && <small className="chat-edited" title={`Edited ${new Date(m.edited_at).toLocaleString()}`}>(edited)</small>}</div>
            {editing?.message.id === m.id ? <div className="chat-edit-form" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) cancelEdit() } }}>
              <label className="chat-sr-only" htmlFor={`chat-edit-${m.id}`}>Edit your message</label>
              <textarea id={`chat-edit-${m.id}`} autoFocus rows={3} maxLength={2000} value={editing.text} readOnly={busy} onChange={(event) => setEditing((current) => current ? { ...current, text: event.target.value } : current)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEdit() } }} />
              <div><span>{editing.text.length}/2000</span><button type="button" disabled={busy} onClick={cancelEdit}>Cancel</button><button type="button" disabled={busy || !editing.text.trim() || editing.text.trim() === editing.message.body} onClick={() => void saveEdit()}>{busy ? 'Saving…' : 'Save'}</button></div>
              {editError && <p role="alert">{editError}</p>}
            </div> : <p>{m.body}</p>}
            <div className="chat-message-actions">{pinned && <small><Pin size={10} />Goal</small>}<button type="button" className={ownPin ? 'chat-pinned' : ''} disabled={busy} aria-label={ownPin ? 'Remove your pin' : 'Pin message as a goal'} aria-pressed={ownPin} title={ownPin ? 'Remove your pin (other people’s pins remain)' : 'Pin as a shared goal'} onClick={() => void togglePin(m)}><Pin size={14} /></button>{own && <button type="button" disabled={busy || !!editing} aria-label="Edit your message" title="Edit your message" onClick={() => startEdit(m)}><Pencil size={14} /></button>}{own && <button type="button" disabled={busy} aria-label="Delete your message" title="Delete your message" onClick={() => setConfirmDelete(m.id)}><Trash2 size={14} /></button>}</div>
            {confirmDelete === m.id && <div className="chat-confirm"><span>Delete this message for both of you?</span><button type="button" disabled={busy} onClick={() => void remove(m)}>Delete</button><button type="button" onClick={() => setConfirmDelete(null)}>Keep</button></div>}
          </article>
        })}
      </div>
      {error && <div className="chat-error" role="alert">{error}<button type="button" onClick={() => void load()}>Retry refresh</button></div>}
      <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <label className="chat-sr-only" htmlFor="chat-draft">Message or goal</label><textarea id="chat-draft" ref={composer} value={draft} readOnly={busy} maxLength={2000} rows={1} placeholder="Message…" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
        <button type="submit" disabled={busy || !draft.trim()} aria-label={busy ? 'Saving' : 'Send message'}><Send size={15} /></button>{draft.length > 1800 && <small>{draft.length}/2000</small>}
      </form>
    </section>}
    <button type="button" ref={launcher} className="chat-launcher" aria-label={open ? 'Close shared chat' : `Open shared chat${unread ? `, ${unread} new messages` : ''}`} aria-expanded={open} aria-controls="portfolio-chat-panel" onClick={() => open ? close() : setOpen(true)}>{open ? <X size={17} /> : <MessageCircle size={18} />}{!open && unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}</button>
  </div>
  </>
}
