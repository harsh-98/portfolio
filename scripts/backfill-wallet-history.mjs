#!/usr/bin/env node

import { execFileSync } from "node:child_process";
// Historical wallet tokens AND DeFi; credentials stay in the protected key file.
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

const args = new Set(process.argv.slice(2))
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
const dryRun = args.has('--dry-run')
const force = args.has('--force')
const from = option('from', '2023-11-01')
const to = option('to', new Date(Date.now() - 86400000).toISOString().slice(0, 10))
const minimum = Number(option('minimum-value', '0.01'))
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keyFile = process.env.PORTFOLIO_SERVER_KEY_FILE
if (!keyFile) throw new Error('Missing PORTFOLIO_SERVER_KEY_FILE')
const config = Object.fromEntries((await fs.readFile(keyFile, 'utf8')).split(/\r?\n/).map((line) => line.trim().replace(/^export\s+/, '')).filter((line) => /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)).map((line) => {
  const index = line.indexOf('=')
  return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]
}))
const required = (name) => {
  const value = process.env[name]?.trim() || config[name]?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const addresses = [...new Set(required('PORTFOLIO_EVM_ADDRESSES').split(',').map((address) => address.trim().toLowerCase()).filter(Boolean))]
if (!addresses.every((address) => /^0x[0-9a-f]{40}$/.test(address))) throw new Error('Invalid configured wallet address')
if (!Number.isFinite(minimum) || minimum < 0) throw new Error('Invalid minimum value')
for (const date of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Invalid date')
const dates = []
const cursor = new Date(`${from}T00:00:00Z`)
cursor.setUTCDate(cursor.getUTCDate() + (9 - cursor.getUTCDay()) % 7)
while (cursor.toISOString().slice(0, 10) <= to) {
  dates.push(cursor.toISOString().slice(0, 10))
  cursor.setUTCDate(cursor.getUTCDate() + 7)
}
if (!dates.length) throw new Error('No Tuesday snapshots within the requested date range')
const apiKey = required('ONEINCH_API_KEY')
const dbUrl = required('SUPABASE_URL').replace(/\/$/, '')
const dbKey = required('SUPABASE_SECRET_KEY')
async function request(url, headers, method = 'GET', body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000) })
    if (response.ok) return response.status === 204 ? null : response.json()
    // Do not log request URLs, headers, or provider error bodies.
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 5) throw new Error(`Request failed: HTTP ${response.status}`)
    await pause(Math.max(1000 * 2 ** attempt, Number(response.headers.get('retry-after') || 0) * 1000))
  }
}
let nextProviderRequest = 0
async function provider(path, params = {}) {
  const start = Math.max(Date.now(), nextProviderRequest)
  nextProviderRequest = start + 1100
  await pause(Math.max(0, start - Date.now()))
  const response = await request(`https://api.1inch.com/portfolio/portfolio/v5.0${path}?${new URLSearchParams(params)}`, { Authorization: `Bearer ${apiKey}`, accept: 'application/json' })
  return response.result ?? response
}
const db = (table, params = {}, method = 'GET', body) => request(`${dbUrl}/rest/v1/${table}?${new URLSearchParams(params)}`, { apikey: dbKey, Authorization: `Bearer ${dbKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, method, body)
let ownerId = process.env.PORTFOLIO_OWNER_ID?.trim() || config.PORTFOLIO_OWNER_ID
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId || '')) {
  const users = await request(`${dbUrl}/auth/v1/admin/users?page=1&per_page=100`, { apikey: dbKey, Authorization: `Bearer ${dbKey}` })
  ownerId = users.users.find((user) => user.email?.toLowerCase() === required('PORTFOLIO_OWNER_EMAIL').toLowerCase())?.id
  if (!ownerId) throw new Error('Configured portfolio owner not found')
}
const chainRows = await provider('/general/supported_chains')
if (!Array.isArray(chainRows)) throw new Error('Unexpected supported-chain response')
const chains = new Map(chainRows.filter((row) => Number(row.chain_id) > 0).map((row) => [Number(row.chain_id), row]))
const accountCache = new Map()
const assetCache = new Map()
async function account(address, chain) {
  const name = `Wallet · ${address} · ${chain.chain_name}`
  if (accountCache.has(name)) return accountCache.get(name)
  const existing = await db('accounts', { owner_id: `eq.${ownerId}`, name: `eq.${name}`, institution: 'eq.1inch History', select: 'id' })
  const id = existing[0]?.id || (await db('accounts', {}, 'POST', { owner_id: ownerId, name, institution: '1inch History', account_type: 'wallet', currency: 'USD', source: 'oneinch-history' }))[0].id
  accountCache.set(name, id)
  return id
}
async function asset(chain, symbol, name, contract, assetClass) {
  const key = `${chain.chain_id}|${symbol}|${contract}|${assetClass}`
  if (!assetCache.has(key)) assetCache.set(key, (async () => {
    const candidates = await db('assets', { owner_id: `eq.${ownerId}`, symbol: `eq.${symbol}`, select: 'id,network,contract_address,asset_class' })
    const existing = candidates.find((item) => item.network === chain.chain_name && (item.contract_address || null) === contract)
    return existing?.id || (await db('assets', {}, 'POST', { owner_id: ownerId, symbol, name, network: chain.chain_name, contract_address: contract, asset_class: assetClass, currency: 'USD', metadata: { provider: '1inch History', chain_id: chain.chain_id } }))[0].id
  })())
  try { return await assetCache.get(key) } catch (error) { assetCache.delete(key); throw error }
}
const checkpointChain = 'oneinch-allchains-v1'
let failed = 0
async function capture(date, address, index) {
  const walletHash = hash(address)
  const checkpoint = { owner_id: `eq.${ownerId}`, wallet_hash: `eq.${walletHash}`, chain_name: `eq.${checkpointChain}`, snapshot_date: `eq.${date}` }
  if (!dryRun && !force && (await db('crypto_backfill_checkpoints', { ...checkpoint, status: 'eq.success', select: 'id' })).length) return
  try {
    const timestamp = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
    const tokens = await provider('/tokens/snapshot', { addresses: address, timestamp })
    const protocols = await provider('/protocols/snapshot', { addresses: address, timestamp })
    if (!Array.isArray(tokens) || !Array.isArray(protocols)) throw new Error('Historical token/DeFi response is not a complete array')
    const normalized = []
    const identities = new Set()
    for (const [kind, items] of [['token', tokens], ['protocol', protocols]]) for (const item of items) {
      if (item.status != null && Number(item.status) !== 1) continue
      const valueRaw = Number(item.value_usd)
      if (!Number.isFinite(valueRaw)) throw new Error('Historical value is missing or invalid')
      if (Math.abs(valueRaw) < minimum) continue
      const chainId = Number(item.chain_id ?? item.chain)
      if (!chains.has(chainId)) throw new Error(`Unrecognized historical chain ${chainId}`)
      const sign = Number(item.asset_sign) < 0 ? -1 : 1
      const value = valueRaw < 0 ? valueRaw : valueRaw * sign
      const underlying = Array.isArray(item.underlying_tokens) ? item.underlying_tokens : []
      const detail = underlying.length === 1 ? underlying[0] : {}
      const contract = String(item.contract_address || detail.contract_address || detail.address || '').toLowerCase() || null
      const symbol = contract === '0xf0795c47fa58d00f5f77f4d5c01f31ee891e21b4' ? 'RUSDC' : String(item.contract_symbol || detail.symbol || (kind === 'protocol' ? 'DEFI' : 'TOKEN')).slice(0, 27).toUpperCase()
      const amount = Number(detail.amount ?? detail.balance ?? item.amount)
      const quantity = Number.isFinite(amount) ? Math.abs(amount) * sign : 0
      const id = `${chainId}:${kind}:${hash(String(item.index ?? `${contract}:${item.protocol_group_id || ''}:${item.protocol_sub_group_id || ''}:${symbol}:${sign}`))}`
      if (identities.has(id)) throw new Error('Duplicate historical position identity')
      identities.add(id)
      normalized.push({ id, chainId, kind, symbol: sign < 0 ? `${symbol}-DEBT` : symbol, name: item.contract_name || detail.name || item.protocol_group_name || symbol, contract, quantity, value, price: quantity ? Math.abs(value / quantity) : 0, protocol: item.protocol_group_name || item.protocol_group_id || null, assetClass: sign < 0 ? 'liability' : ['USDT','USDC','DAI','USDE','FRAX','LUSD','GHO','USD0','USDT0','RUSDC'].includes(symbol) ? 'stablecoin' : ['XAUT','XAUT0','PAXG'].includes(symbol) ? 'gold' : 'crypto' })
    }
    const total = normalized.reduce((sum, row) => sum + row.value, 0)
    console.log(JSON.stringify({ date, wallet: index + 1, mode: dryRun ? 'read-only' : 'write', positions: normalized.length, token_value_usd: +normalized.filter((r) => r.kind === 'token').reduce((s, r) => s + r.value, 0).toFixed(2), defi_value_usd: +normalized.filter((r) => r.kind === 'protocol').reduce((s, r) => s + r.value, 0).toFixed(2), total_value_usd: +total.toFixed(2), networks: [...new Set(normalized.map((r) => chains.get(r.chainId).chain_name))] }))
    if (dryRun) return
    if (!normalized.length) {
      const end = new Date(`${date}T00:00:00Z`)
      end.setUTCDate(end.getUTCDate() + 6)
      const legacy = await db('position_snapshots', { owner_id: `eq.${ownerId}`, source_key: `like.backfill:${walletHash}:%`, and: `(snapshot_date.gte.${date},snapshot_date.lte.${end.toISOString().slice(0, 10)})`, select: 'value_usd' })
      if (legacy.some((row) => Math.abs(Number(row.value_usd)) >= 0.01)) throw new Error('Empty provider response conflicts with retained legacy history; existing data preserved')
    }
    const rows = []
    const markers = []
    const batch = hash(`${walletHash}:${date}:${Date.now()}`)
    const metadata = { snapshot_kind: 'reconstructed', provider: '1inch History', history_complete: true, history_batch: batch, wallet_hash: walletHash, timestamp, includes_protocols: true }
    for (const position of normalized) {
      const chain = chains.get(position.chainId)
      rows.push({ owner_id: ownerId, snapshot_date: date, source_key: `history:oneinch:${walletHash}:${position.id}:${batch}`, account_id: await account(address, chain), asset_id: await asset(chain, position.symbol, position.name, position.contract, position.assetClass), quantity: position.quantity, price_usd: position.price, value_usd: +position.value.toFixed(2), metadata: { ...metadata, chain_id: position.chainId, protocol_name: position.protocol, balance_type: position.kind === 'protocol' ? 'protocol_position' : 'wallet_token' } })
    }
    // Explicit zero-coverage markers prevent stale balances from surviving an empty snapshot.
    for (const chain of chains.values()) {
      markers.push({ owner_id: ownerId, snapshot_date: date, source_key: `history:oneinch:${walletHash}:${chain.chain_id}:coverage`, account_id: await account(address, chain), asset_id: await asset(chain, 'COVERAGE', 'Historical network coverage', null, 'crypto'), quantity: 0, price_usd: 0, value_usd: 0, metadata: { ...metadata, chain_id: chain.chain_id, coverage_only: true } })
    }
    for (let offset = 0; offset < rows.length; offset += 100) await db('position_snapshots', { on_conflict: 'owner_id,snapshot_date,source_key' }, 'POST', rows.slice(offset, offset + 100))
    // Publish all network coverage markers together only after the complete batch is stored.
    // Readers ignore rows whose batch has not been published by a coverage marker.
    await db('position_snapshots', { on_conflict: 'owner_id,snapshot_date,source_key' }, 'POST', markers)
    // Only prune this provider's superseded rows after all token/DeFi responses and writes succeeded.
    const existing = await db('position_snapshots', { owner_id: `eq.${ownerId}`, snapshot_date: `eq.${date}`, source_key: `like.history:oneinch:${walletHash}:%`, select: 'id,source_key' })
    const keep = new Set([...rows, ...markers].map((row) => row.source_key))
    for (const row of existing.filter((row) => !keep.has(row.source_key))) await db('position_snapshots', { owner_id: `eq.${ownerId}`, id: `eq.${row.id}` }, 'DELETE')
    await db('crypto_backfill_checkpoints', { on_conflict: 'owner_id,wallet_hash,chain_name,snapshot_date' }, 'POST', { owner_id: ownerId, wallet_hash: walletHash, chain_name: checkpointChain, snapshot_date: date, status: 'success', records_written: rows.length + markers.length, message: 'Tokens and DeFi; same-date all-network snapshot', completed_at: new Date().toISOString() })
  } catch (error) {
    failed++
    console.error(JSON.stringify({ date, wallet: index + 1, error: error.message }))
    if (!dryRun) await db('crypto_backfill_checkpoints', { on_conflict: 'owner_id,wallet_hash,chain_name,snapshot_date' }, 'POST', { owner_id: ownerId, wallet_hash: walletHash, chain_name: checkpointChain, snapshot_date: date, status: 'failed', records_written: 0, message: error.message, completed_at: new Date().toISOString() })
  }
}
if (args.has('--newest-first')) dates.reverse()
for (const date of dates) await Promise.all(addresses.map((address, index) => capture(date, address, index)))
if (failed) process.exitCode = 1

if (!dryRun) execFileSync("python3", [new URL("./build-history-charts.py", import.meta.url).pathname], { stdio: "inherit" });
