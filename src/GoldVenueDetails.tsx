import { useMemo } from 'react'
import type { Position } from './types'
import { TickerThesis } from './TickerThesis'

export function GoldVenueDetails({ positions, location, symbolFor, formatMoney, formatPrice }: {
  positions: Position[]
  location: (position: Position) => string
  symbolFor: (symbol: string) => string
  formatMoney: (value: number) => string
  formatPrice: (value: number) => string
}) {
  const rows = useMemo(() => {
    const grouped = new Map<string, { symbol: string; venue: string; quantity: number; value: number; knownValue: number; cost: number; known: number; count: number }>()
    for (const position of positions) {
      const symbol = symbolFor(position.asset.symbol), venue = location(position)
      const key = JSON.stringify([symbol, venue])
      const row = grouped.get(key) || { symbol, venue, quantity: 0, value: 0, knownValue: 0, cost: 0, known: 0, count: 0 }
      row.quantity += Number(position.quantity); row.value += Number(position.value_usd); row.count++
      if (position.cost_basis_usd != null && Number.isFinite(Number(position.cost_basis_usd))) {
        row.knownValue += Number(position.value_usd); row.cost += Number(position.cost_basis_usd); row.known++
      }
      grouped.set(key, row)
    }
    return [...grouped.values()].sort((a, b) => b.value - a.value || a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue))
  }, [positions, location, symbolFor])
  return <div className="gold-venue-details">
    <table className="gold-venue-table" aria-label="Gold prices and unrealized profit by venue">
      <colgroup><col style={{ width: '40%' }} /><col style={{ width: '30%' }} /><col style={{ width: '30%' }} /></colgroup>
      <thead><tr><th>Asset / venue</th><th>Current price</th><th>Unrealized P/L</th></tr></thead>
      <tbody>{rows.map((row) => {
        const pnl = row.knownValue - row.cost
        const percent = row.cost > 0 ? pnl / row.cost * 100 : null
        const price = row.quantity > 0 ? row.value / row.quantity : null
        return <tr key={JSON.stringify([row.symbol, row.venue])}>
          <td className="gold-venue-label"><strong><TickerThesis symbol={row.symbol} /></strong><small>{row.venue}</small><small>({row.quantity.toLocaleString('en-US', { maximumFractionDigits: 6 })} {row.symbol === 'IAU' ? 'shares' : 'units'})</small></td>
          <td title="Current value per unit using the dashboard’s latest available prices">{price == null ? '—' : formatPrice(price)}<small title={`Holding value ${formatMoney(row.value)}`}>Value {formatMoney(row.value)}</small></td>
          <td className={`gold-venue-pnl${!row.known || pnl === 0 ? '' : pnl > 0 ? ' value-positive' : ' value-negative'}`} title={row.known < row.count ? 'Only positions with recorded purchase costs are included.' : 'Unrealized profit or loss against recorded purchase cost'}>{row.known ? `${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}` : 'Cost pending'}{row.known > 0 && <small>{percent == null ? '—' : `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`}</small>}{row.known > 0 && row.known < row.count && <small>Known costs only</small>}</td>
        </tr>
      })}</tbody>
    </table>
  </div>
}
