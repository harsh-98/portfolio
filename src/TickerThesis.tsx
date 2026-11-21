import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import './thesis.css'

const ThesisEditor = lazy(() => import('./ThesisEditor'))
const prefix = '#/symbol/'
function routeSymbol() {
  const hash = window.location.hash
  if (!hash.startsWith(prefix) || !hash.endsWith('/thesis')) return null
  try { return decodeURIComponent(hash.slice(prefix.length, -7)).trim().toUpperCase().slice(0, 120) || null } catch { return null }
}
export function TickerThesis({ symbol, children }: { symbol: string; children?: ReactNode }) {
  return <a className="ticker-thesis-link" href={`${prefix}${encodeURIComponent(symbol.trim().toUpperCase())}/thesis`} title={`${symbol} · investment thesis`} onClick={(event) => event.stopPropagation()}>{children || symbol}</a>
}
export function ThesisRouter({ session }: { session: Session }) {
  const [symbol, setSymbol] = useState(routeSymbol)
  useEffect(() => {
    const change = () => setSymbol(routeSymbol())
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  function close() {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    setSymbol(null)
  }
  return symbol ? <Suspense fallback={<div className="thesis-loading" role="status">Opening {symbol} thesis…</div>}><ThesisEditor key={`${session.user.id}:${symbol}`} symbol={symbol} session={session} onClose={close} /></Suspense> : null
}
