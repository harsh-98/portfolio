const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders })

  const apiKey = Deno.env.get('FMP_API_KEY')
  if (!apiKey) return Response.json({ error: 'Stock quote feed is not configured' }, { status: 503, headers: corsHeaders })

  try {
    const body = await request.json()
    const symbols = [...new Set((Array.isArray(body?.symbols) ? body.symbols : [])
      .map((value: unknown) => String(value).trim().toUpperCase())
      .filter((value: string) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(value)))]
      .slice(0, 50)
    if (!symbols.length) return Response.json({ error: 'No valid symbols supplied' }, { status: 400, headers: corsHeaders })

    const endpoint = new URL('https://financialmodelingprep.com/stable/batch-quote')
    endpoint.searchParams.set('symbols', symbols.join(','))
    endpoint.searchParams.set('apikey', apiKey)
    const quoteResponse = await fetch(endpoint)
    const quotes = await quoteResponse.json()
    if (!quoteResponse.ok || !Array.isArray(quotes)) throw new Error(`Quote provider returned ${quoteResponse.status}`)
    const prices = Object.fromEntries(quotes
      .map((quote) => [String(quote.symbol || '').toUpperCase(), Number(quote.price)])
      .filter(([symbol, price]) => symbol && Number.isFinite(price) && price > 0))
    return Response.json({ prices, as_of: new Date().toISOString() }, { headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=45' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Quote request failed' }, { status: 502, headers: corsHeaders })
  }
})
