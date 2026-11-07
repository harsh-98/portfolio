export async function fetchUsdInr(signal: AbortSignal) {
  const response = await fetch('https://api.frankfurter.dev/v2/rates?base=USD&quotes=INR&providers=ecb', {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(`USD/INR request failed (HTTP ${response.status}).`)
  const rows = await response.json()
  const quote = Array.isArray(rows) ? rows.find((row) => row.base === 'USD' && row.quote === 'INR') : null
  const rate = Number(quote?.rate)
  const date = String(quote?.date || '')
  if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > new Date().toISOString().slice(0, 10)) {
    throw new Error('USD/INR feed returned an invalid or future-dated reference rate.')
  }
  return { rate, date, fetchedAt: new Date().toISOString() }
}
