import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'

interface Props {
  snapshots: Array<{ snapshot_date: string; total_value_usd: number }>
  formatMoney: (value: number) => string
}
const DAY = 86400000
const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export function PortfolioSparkline({ snapshots, formatMoney }: Props) {
  const [range, setRange] = useState<'1M' | '1Y'>('1M')
  const [selected, setSelected] = useState<number | null>(null)
  const points = useMemo(() => {
    const today = new Date()
    const cutoff = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (range === '1M' ? 30 : 365) * DAY
    const data = snapshots.map((snapshot) => ({ date: snapshot.snapshot_date, time: Date.parse(`${snapshot.snapshot_date}T00:00:00Z`), value: Number(snapshot.total_value_usd) }))
      .filter((point) => point.time >= cutoff && Number.isFinite(point.value)).sort((a, b) => a.time - b.time)
    if (data.length <= 200) return data
    // Keep endpoints and each time bucket's low/high, at most 200 points.
    const sampled = [data[0]]
    for (let bin = 0; bin < 99; bin++) {
      const start = 1 + Math.floor(bin * (data.length - 2) / 99)
      const end = 1 + Math.floor((bin + 1) * (data.length - 2) / 99)
      const bucket = data.slice(start, end)
      if (!bucket.length) continue
      const low = bucket.reduce((a, b) => a.value <= b.value ? a : b)
      const high = bucket.reduce((a, b) => a.value >= b.value ? a : b)
      sampled.push(...(low === high ? [low] : [low, high].sort((a, b) => a.time - b.time)))
    }
    return [...sampled, data[data.length - 1]]
  }, [snapshots, range])
  const currentIndex = Math.min(selected ?? points.length - 1, points.length - 1)
  const current = points[currentIndex]
  const first = points[0], last = points[points.length - 1]
  const minimum = Math.min(...points.map((point) => point.value))
  const maximum = Math.max(...points.map((point) => point.value))
  const x = (time: number) => points.length === 1 ? 100 : 3 + (time - first.time) / Math.max(last.time - first.time, 1) * 194
  const y = (value: number) => maximum === minimum ? 16 : 28 - (value - minimum) / (maximum - minimum) * 24
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ')
  function inspect(event: PointerEvent<SVGSVGElement>) {
    if (!points.length) return
    const rect = event.currentTarget.getBoundingClientRect()
    const target = first.time + Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * 200 - 3) / 194)) * (last.time - first.time)
    let nearest = 0
    points.forEach((point, index) => { if (Math.abs(point.time - target) < Math.abs(points[nearest].time - target)) nearest = index })
    setSelected(nearest)
  }
  function navigate(event: KeyboardEvent<SVGSVGElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, currentIndex + (event.key === 'ArrowLeft' ? -1 : 1))))
  }
  return <div className="portfolio-sparkline" role="group" aria-label="Portfolio snapshots">
    <div className="portfolio-sparkline-heading">
      <div className="portfolio-sparkline-readout" role="status">{current ? <><strong>{formatMoney(current.value)}</strong><span>{dateLabel(current.date)}</span></> : <span>Portfolio snapshots</span>}</div>
      <div className="portfolio-sparkline-range" role="group" aria-label="Portfolio history range">{(['1M', '1Y'] as const).map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => { setRange(value); setSelected(null) }}>{value}</button>)}</div>
    </div>
    {current ? <div className="portfolio-sparkline-plot">
      <button type="button" aria-label="Previous portfolio snapshot" disabled={currentIndex === 0} onClick={() => setSelected(currentIndex - 1)}>‹</button>
      <svg width="200" height="32" viewBox="0 0 200 32" preserveAspectRatio="none" role="slider" tabIndex={0} aria-label="Portfolio value history. Use arrow keys to inspect snapshots." aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={currentIndex} aria-valuetext={`${dateLabel(current.date)}: ${formatMoney(current.value)}`} onPointerMove={inspect} onPointerDown={inspect} onKeyDown={navigate}>
        <rect width="200" height="32" fill="transparent" pointerEvents="all" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <line x1={x(current.time)} x2={x(current.time)} y1="0" y2="32" stroke="currentColor" strokeOpacity="0.35" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        {points.map((point) => <circle key={point.date} cx={x(point.time)} cy={y(point.value)} r={points.length > 30 ? 0.9 : 1.8} fill="#0d1216" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke"><title>{dateLabel(point.date)}: {formatMoney(point.value)}</title></circle>)}
        <circle cx={x(current.time)} cy={y(current.value)} r="2.7" fill="currentColor"><title>{dateLabel(current.date)}: {formatMoney(current.value)}</title></circle>
      </svg>
      <button type="button" aria-label="Next portfolio snapshot" disabled={currentIndex === points.length - 1} onClick={() => setSelected(currentIndex + 1)}>›</button>
    </div> : <span className="portfolio-sparkline-empty">No snapshots in this range</span>}
  </div>
}
