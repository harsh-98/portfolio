const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders })

  try {
    const body = await request.json()
    const symbols = [...new Set((Array.isArray(body?.symbols) ? body.symbols : [])
      .map((value: unknown) => String(value).trim().toUpperCase())
      .filter((value: string) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(value)))]
      .slice(0, 50)
    if (!symbols.length) return Response.json({ error: 'No valid symbols supplied' }, { status: 400, headers: corsHeaders })

    const endpoint = new URL('https://query1.finance.yahoo.com/v7/finance/spark')
    endpoint.searchParams.set('symbols', symbols.join(','))
    endpoint.searchParams.set('range', '1d')
    endpoint.searchParams.set('interval', '1m')
    const quoteResponse = await fetch(endpoint, {
      headers: { 'User-Agent': 'Mozilla/5.0 Northstar/1.0', Accept: 'application/json' },
    })
    const payload = await quoteResponse.json()
    const quotes = payload?.spark?.result
    if (!quoteResponse.ok || !Array.isArray(quotes)) throw new Error(`Yahoo Finance returned ${quoteResponse.status}`)
    const prices = Object.fromEntries(quotes
      .map((quote) => [String(quote.symbol || '').toUpperCase(), Number(quote.response?.[0]?.meta?.regularMarketPrice)])
      .filter(([symbol, price]) => symbol && Number.isFinite(price) && price > 0))
    if (!Object.keys(prices).length) throw new Error('Yahoo Finance returned no current prices')
    return Response.json({ prices, as_of: new Date().toISOString(), source: 'Yahoo Finance' }, { headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=45' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Quote request failed' }, { status: 502, headers: corsHeaders })
  }
})
