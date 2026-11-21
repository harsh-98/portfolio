import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { MessageCircle, Pin, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { supabase } from './lib/supabase'
import './chat.css'

// Metadata-only records use the existing approved-user read / owner-write policies.
// There are no positions for these records, so they never enter portfolio totals.
const MESSAGE = '_PORTFOLIO_CHAT'
const PIN = '_PORTFOLIO_CHAT_PIN'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Message = { id: string; owner_id: string; created_at: string; body: string; author: string }
type GoalPin = { id: string; owner_id: string; messageId: string; author: string }
type Row = { id: string; owner_id: string; created_at: string; metadata: Record<string, unknown> }
const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 60) : 'Member'
const failure = (error: unknown) => error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Please try again.'

export function PortfolioChat({ session }: { session: Session }) {
  const userId = session.user.id
  const author = label(session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Member')
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [pins, setPins] = useState<GoalPin[]>([])
  const [draft, setDraft] = useState('')
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
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const [recent, savedPins] = await Promise.all([
        supabase.from('assets').select('id,owner_id,created_at,metadata').eq('symbol', MESSAGE).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1).abortSignal(controller.signal),
        supabase.from('assets').select('id,owner_id,created_at,metadata').eq('symbol', PIN).order('created_at', { ascending: false }).limit(1000).abortSignal(controller.signal),
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
        const older = await supabase.from('assets').select('id,owner_id,created_at,metadata').eq('symbol', MESSAGE).in('id', missing.slice(i, i + 100)).abortSignal(controller.signal)
        if (older.error) throw older.error
        rows.push(...(older.data || []) as Row[])
      }
      const parsed: Message[] = rows.flatMap((row) => {
        const chat = row.metadata.chat as { body?: unknown; author?: unknown } | undefined
        return chat && typeof chat.body === 'string' && chat.body.trim() ? [{ id: row.id, owner_id: row.owner_id, created_at: row.created_at, body: chat.body.slice(0, 2000), author: label(chat.author) }] : []
      }).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      if (!mounted.current) return
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
  return <div className="portfolio-chat">
    {open && <section id="portfolio-chat-panel" className="chat-panel" aria-label="Shared chat and goals" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <header className="chat-header"><div><strong>Chat & goals</strong><small>A shared space for the two of you</small></div><button type="button" onClick={() => void load()} aria-label="Refresh chat" title="Refresh chat"><RefreshCw size={16} /></button><button type="button" onClick={close} aria-label="Close chat"><X size={19} /></button></header>
      {goals.length > 0 && <details className="chat-goals" open><summary><Pin size={13} />Pinned goals <span>{goals.length}</span></summary><div>{goals.map((m) => <button type="button" key={m.id} onClick={() => { document.getElementById(`chat-${m.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); document.getElementById(`chat-${m.id}`)?.focus({ preventScroll: true }) }}><span>{m.body}</span><small>{[...new Set(pins.filter((p) => p.messageId === m.id).map((p) => p.owner_id === userId ? 'you' : p.author))].join(' & ')}</small></button>)}</div></details>}
      <div className="chat-timeline" ref={timeline} role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions" onScroll={() => { const el = timeline.current; if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70 }}>
        {hasOlder && <button type="button" className="chat-older" disabled={busy} onClick={() => { nearBottom.current = false; setLimit((v) => v + 50) }}>Load earlier messages</button>}
        {loading && <p className="chat-empty">Loading conversation…</p>}
        {!loading && !messages.length && <div className="chat-empty"><MessageCircle size={25} /><strong>Your shared space</strong><p>Send a message or write a goal.<br />Use the pin on a message to keep it above the chat.</p></div>}
        {messages.map((m) => {
          const own = m.owner_id === userId
          const ownPin = pins.some((p) => p.messageId === m.id && p.owner_id === userId)
          const pinned = pins.some((p) => p.messageId === m.id)
          return <article id={`chat-${m.id}`} tabIndex={-1} className={`chat-message${own ? ' chat-own' : ''}`} key={m.id}>
            <div className="chat-message-meta"><strong>{own ? 'You' : m.author}</strong><time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString()}>{new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div>
            <p>{m.body}</p>
            <div className="chat-message-actions">{pinned && <small><Pin size={10} />Goal</small>}<button type="button" className={ownPin ? 'chat-pinned' : ''} disabled={busy} aria-label={ownPin ? 'Remove your pin' : 'Pin message as a goal'} aria-pressed={ownPin} title={ownPin ? 'Remove your pin (other people’s pins remain)' : 'Pin as a shared goal'} onClick={() => void togglePin(m)}><Pin size={14} /></button>{own && <button type="button" disabled={busy} aria-label="Delete your message" title="Delete your message" onClick={() => setConfirmDelete(m.id)}><Trash2 size={14} /></button>}</div>
            {confirmDelete === m.id && <div className="chat-confirm"><span>Delete this message for both of you?</span><button type="button" disabled={busy} onClick={() => void remove(m)}>Delete</button><button type="button" onClick={() => setConfirmDelete(null)}>Keep</button></div>}
          </article>
        })}
      </div>
      {error && <div className="chat-error" role="alert">{error}<button type="button" onClick={() => void load()}>Retry refresh</button></div>}
      <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <label className="chat-sr-only" htmlFor="chat-draft">Message or goal</label><textarea id="chat-draft" ref={composer} value={draft} readOnly={busy} maxLength={2000} rows={2} placeholder="Message or a goal…" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
        <button type="submit" disabled={busy || !draft.trim()} aria-label={busy ? 'Saving' : 'Send message'}><Send size={18} /></button><small>Enter to send · Shift + Enter for a new line{draft.length > 1800 ? ` · ${draft.length}/2000` : ''}</small>
      </form>
    </section>}
    <button type="button" ref={launcher} className="chat-launcher" aria-label={open ? 'Close shared chat' : `Open shared chat${unread ? `, ${unread} new messages` : ''}`} aria-expanded={open} aria-controls="portfolio-chat-panel" onClick={() => open ? close() : setOpen(true)}>{open ? <X size={21} /> : <MessageCircle size={22} />}<span>{open ? 'Close' : 'Chat'}{!open && unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}</span></button>
  </div>
}
