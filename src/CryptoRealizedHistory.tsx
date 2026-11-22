import { useId, useRef, useState } from 'react'
import type { BrokerageTransaction } from './types'
import { TickerThesis } from './TickerThesis'
import './options.css'

export function CryptoRealizedHistory({ transactions, formatMoney, symbol, onRefresh }: { transactions: BrokerageTransaction[]; formatMoney: (value: number) => string; symbol?: string; onRefresh?: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  async function refresh() {
    if (!onRefresh || refreshing) return
    setRefreshing(true); setError('')
    try { await onRefresh() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to refresh recorded sales.') }
    finally { setRefreshing(false) }
  }
  const known = transactions.filter((row) => row.realized_pnl_usd != null)
  const total = known.reduce((sum, row) => sum + Number(row.realized_pnl_usd), 0)
  const signed = (value: number) => `${value >= 0 ? '+' : ''}${formatMoney(value)}`
  return <>
    <button type="button" className="option-history-button" onClick={() => { dialog.current?.showModal(); void refresh() }}><span className="option-history-button-label">{symbol ? `${symbol} · recorded sales` : 'Recorded crypto sales'} <small>{transactions.length} sales</small></span><b className={!known.length ? '' : total >= 0 ? 'value-positive' : 'value-negative'}>{known.length ? signed(total) : '—'}</b></button>
    <dialog ref={dialog} className="option-history" aria-labelledby={titleId} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close() }}>
      <div className="option-history-heading"><h2 id={titleId}>{symbol ? `${symbol} realized history` : 'Crypto realized history'}</h2><button type="button" aria-label="Close crypto realized history" onClick={() => dialog.current?.close()}>×</button></div>
      <div className="option-realized-total"><span>Realized P/L · after recorded fees{known.length < transactions.length ? ' · known costs only' : ''}</span><strong className={!known.length ? '' : total >= 0 ? 'value-positive' : 'value-negative'}>{known.length ? signed(total) : '—'}</strong></div>
      <div className="crypto-history-status"><span role="status">{refreshing ? 'Refreshing recorded sales…' : `${transactions.length} recorded sales${known.length < transactions.length ? ` · ${transactions.length - known.length} cost pending` : ''}`}</span>{onRefresh && <button type="button" disabled={refreshing} onClick={() => void refresh()}>Refresh sales</button>}</div>
      {error && <p className="value-negative" role="alert">{error}</p>}
      <p>Historical sales only. These records do not add or subtract holdings, cash, or portfolio value. Missing purchase costs show “Cost pending”.</p>
      <div className="option-history-list"><div className="option-table-scroll"><table>
        <thead><tr><th>Date</th><th>Asset / venue</th><th>Units sold</th><th>Sale price</th><th>Net proceeds</th><th>Purchase cost</th><th>Realized P/L</th></tr></thead>
        <tbody>{transactions.map((row) => {
          const basis = row.metadata?.purchase_value_usd
          const note = String(row.metadata?.basis_description || '')
          const tx = String(row.metadata?.acquisition_tx || '')
          return <tr key={row.id}>
            <td>{new Date(row.event_time).toLocaleDateString()}</td><td><TickerThesis symbol={row.asset?.symbol || 'Unknown'} /><small style={{ display: 'block', color: '#94a2aa' }}>{row.account?.institution || row.account?.name || 'Wallet'}</small></td>
            <td>{Number(row.quantity || 0).toLocaleString('en-US', { maximumFractionDigits: 8 })}</td><td>{row.price_usd == null ? '—' : formatMoney(Number(row.price_usd))}</td><td>{row.amount_usd == null ? '—' : formatMoney(Number(row.amount_usd))}</td>
            <td title={note}>{basis == null ? 'Cost pending' : formatMoney(Number(basis))}{/^0x[\da-f]{64}$/i.test(tx) && <a style={{ display: 'block', color: '#aebbf5' }} href={`https://etherscan.io/tx/${tx}`} target="_blank" rel="noreferrer">Acquisition swap</a>}</td>
            <td className={row.realized_pnl_usd == null ? '' : Number(row.realized_pnl_usd) >= 0 ? 'value-positive' : 'value-negative'}>{row.realized_pnl_usd == null ? '—' : signed(Number(row.realized_pnl_usd))}</td>
          </tr>
        })}</tbody>
      </table></div>{!transactions.length && !refreshing && <p>No recorded crypto sales{symbol ? ` for ${symbol}` : ''}.</p>}</div>
    </dialog>
  </>
}
