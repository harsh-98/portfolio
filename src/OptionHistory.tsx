import { useMemo, useRef } from 'react'
import type { BrokerageTransaction } from './types'
import './options.css'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function OptionHistory({ transactions }: { transactions: BrokerageTransaction[] }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const groups = useMemo(() => {
    const result = new Map<string, { symbol: string; venue: string; rows: BrokerageTransaction[] }>()
    for (const row of transactions) {
      const symbol = row.asset?.symbol || ''
      if (row.metadata?.instrument_type !== 'option' && !/\b\d{2}\/\d{2}\/\d{4}\s+[\d.]+\s+[CP]$/.test(symbol)) continue
      const venue = row.account?.name || row.account?.institution || 'Broker'
      const key = JSON.stringify([symbol, venue])
      const group = result.get(key) || { symbol, venue, rows: [] }
      group.rows.push(row)
      result.set(key, group)
    }
    return [...result.values()].map((group) => ({
      ...group,
      rows: group.rows.sort((a, b) => a.event_time.localeCompare(b.event_time) || a.id.localeCompare(b.id)),
    })).sort((a, b) => b.rows[b.rows.length - 1].event_time.localeCompare(a.rows[a.rows.length - 1].event_time) || a.symbol.localeCompare(b.symbol))
  }, [transactions])

  return <>
    <button type="button" className="option-history-button" onClick={() => dialog.current?.showModal()}>Options · buy / sell history <span>{groups.length} option series</span></button>
    <dialog ref={dialog} className="option-history" aria-labelledby="option-history-title" onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close() }}>
    <div className="option-history-heading"><h2 id="option-history-title">Options history</h2><button type="button" aria-label="Close options history" onClick={() => dialog.current?.close()}>×</button></div>
    <p>Includes sold and expired options. Premiums are USD per share; totals include reported fees. Each standard contract covers 100 shares.</p>
    {!groups.length && <p>No option transactions in the imported history.</p>}
    <div className="option-history-list">{groups.map((group) => <article key={JSON.stringify([group.symbol, group.venue])}>
      <header><strong>{group.symbol}</strong><small>{group.venue}</small></header>
      <div className="option-table-scroll"><table>
        <thead><tr><th>Date</th><th>Trade</th><th>Contracts</th><th>Premium</th><th>Fees</th><th>Paid / received</th></tr></thead>
        <tbody>{group.rows.map((row) => <tr key={row.id}>
          <td>{String(row.metadata?.raw_date || row.event_time.slice(0, 10))}</td>
          <td>{row.event_type}</td>
          <td>{row.quantity == null ? '—' : Math.abs(Number(row.quantity))}</td>
          <td>{row.price_usd == null ? '—' : usd.format(Number(row.price_usd))}</td>
          <td>{row.metadata?.fees_usd == null ? '—' : usd.format(Number(row.metadata.fees_usd))}</td>
          <td className={row.amount_usd == null || Number(row.amount_usd) === 0 ? '' : Number(row.amount_usd) > 0 ? 'value-positive' : 'value-negative'}>{row.amount_usd == null ? '—' : `${Number(row.amount_usd) > 0 ? '+' : ''}${usd.format(Number(row.amount_usd))}`}</td>
        </tr>)}</tbody>
      </table></div>
    </article>)}</div>
    </dialog>
  </>
}
