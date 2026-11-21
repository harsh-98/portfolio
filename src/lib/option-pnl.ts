import type { BrokerageTransaction } from '../types'

// Match within one broker and exact option series. Cash amounts already include
// reported trading fees; premiums must not be multiplied into cash a second time.
export function optionRealizedPnl(rows: BrokerageTransaction[]) {
  const lots: Array<{ quantity: number; unitCost: number | null }> = []
  return rows.map((transaction) => {
    const type = transaction.event_type.toLowerCase()
    const quantity = Math.abs(Number(transaction.quantity || 0))
    const amount = transaction.amount_usd == null ? null : Number(transaction.amount_usd)
    if (type === 'buy to open' && quantity > 0) {
      lots.push({ quantity, unitCost: amount != null && amount <= 0 ? -amount / quantity : null })
    }
    const closing = type === 'sell to close' || type === 'expired'
    let realizedPnl: number | null = null
    let basis: number | null = null
    if (closing && quantity > 0) {
      let remaining = quantity, cost = 0, knownCost = true
      while (remaining > 1e-8 && lots.length) {
        const lot = lots[0]
        const matched = Math.min(remaining, lot.quantity)
        if (lot.unitCost == null) knownCost = false
        else cost += matched * lot.unitCost
        remaining -= matched
        lot.quantity -= matched
        if (lot.quantity < 1e-8) lots.shift()
      }
      if (knownCost && remaining < 1e-8) {
        basis = cost
        if (amount != null) realizedPnl = amount - cost
      }
    }
    // Preserve explicit broker P/L when supplied, rather than replacing it.
    if (transaction.realized_pnl_usd != null) realizedPnl = Number(transaction.realized_pnl_usd)
    return { transaction, closing, realizedPnl, basis }
  })
}
