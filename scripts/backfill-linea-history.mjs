#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

const argValue = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
const fromDate = argValue('from', '2024-11-02')
const toDate = argValue('to', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
const minimumValue = Number(argValue('minimum-value', '100'))
const chainName = 'linea-mainnet'
const rpcUrl = 'https://rpc.linea.build'
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)

function parseKeyFile(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')]
  }))
}

const credentialsPath = process.env.PORTFOLIO_SERVER_KEY_FILE?.trim()
if (!credentialsPath) throw new Error('Missing PORTFOLIO_SERVER_KEY_FILE')
const credentials = parseKeyFile(await fs.readFile(credentialsPath, 'utf8'))
const required = (name) => {
  const value = process.env[name]?.trim() || credentials[name]?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const configuredAddresses = required('PORTFOLIO_EVM_ADDRESSES').split(',').map((value) => value.trim()).filter(Boolean)
const requestedAddresses = argValue('addresses', '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
const addresses = configuredAddresses.filter((value) => !requestedAddresses.length || requestedAddresses.includes(value.toLowerCase()))
if (!addresses.length) throw new Error('No configured wallet matched --addresses')

function weeklyDates(start, end) {
  const dates = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const limit = new Date(`${end}T00:00:00Z`)
  while (cursor <= limit) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  return dates
}

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const body = await response.json().catch(() => ({}))
    if (response.ok && body.result != null) return body.result
    if (attempt === 4) throw new Error(`Linea RPC ${response.status}: ${body.error?.message || 'request failed'}`)
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

const blockCache = new Map()
async function block(number) {
  if (blockCache.has(number)) return blockCache.get(number)
  const raw = await rpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])
  const value = { number: Number.parseInt(raw.number, 16), timestamp: Number.parseInt(raw.timestamp, 16) }
  blockCache.set(number, value)
  return value
}

async function blockAtOrBefore(targetTimestamp, lower, upper) {
  let low = lower
  let high = upper
  while (high.number - low.number > 1) {
    const spanSeconds = high.timestamp - low.timestamp
    const ratio = spanSeconds > 0 ? (targetTimestamp - low.timestamp) / spanSeconds : 0.5
    let guess = Math.floor(low.number + Math.max(0.05, Math.min(0.95, ratio)) * (high.number - low.number))
    if (high.number - low.number < 50) guess = Math.floor((low.number + high.number) / 2)
    guess = Math.max(low.number + 1, Math.min(high.number - 1, guess))
    const candidate = await block(guess)
    if (candidate.timestamp <= targetTimestamp) low = candidate
    else high = candidate
  }
  return low
}

async function ethPrices(dates) {
  const start = Date.parse(`${dates[0]}T00:00:00Z`)
  const end = Date.parse(`${dates.at(-1)}T23:59:59Z`)
  const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&startTime=${start}&endTime=${end}&limit=1000`)
  const rows = await response.json()
  if (!response.ok || !Array.isArray(rows)) throw new Error(`Binance price history failed: ${response.status}`)
  return new Map(rows.map((row) => [new Date(row[0]).toISOString().slice(0, 10), Number(row[4])]))
}

const supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '')
const supabaseKey = required('SUPABASE_SECRET_KEY')
const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' }
async function supabase(endpoint, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${supabaseUrl}${endpoint}`, { method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`Supabase ${method} ${response.status}: ${data?.message || text.slice(0, 160)}`)
  return data
}

let ownerId = process.env.PORTFOLIO_OWNER_ID?.trim() || credentials.PORTFOLIO_OWNER_ID?.trim()
if (!ownerId) {
  const users = await supabase('/auth/v1/admin/users?page=1&per_page=100')
  const email = required('PORTFOLIO_OWNER_EMAIL').toLowerCase()
  ownerId = users.users.find((user) => user.email?.toLowerCase() === email)?.id
  if (!ownerId) throw new Error('Configured portfolio owner was not found')
}

async function ensureAccount(address) {
  const name = `Wallet · ${address} · Linea`
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, name: `eq.${name}`, select: 'id' })
  const existing = await supabase(`/rest/v1/accounts?${query}`)
  return existing[0]?.id || (await supabase('/rest/v1/accounts', { method: 'POST', body: { owner_id: ownerId, name, institution: 'Linea RPC', account_type: 'wallet', currency: 'USD', source: 'linea-rpc-backfill' }, prefer: 'return=representation' }))[0].id
}

async function ensureEthAsset() {
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, symbol: 'eq.ETH', select: 'id,network,contract_address' })
  const candidates = await supabase(`/rest/v1/assets?${query}`)
  const existing = candidates.find((asset) => String(asset.network).toLowerCase() === 'linea' && !asset.contract_address)
  return existing?.id || (await supabase('/rest/v1/assets', { method: 'POST', body: { owner_id: ownerId, symbol: 'ETH', name: 'Ether', asset_class: 'crypto', currency: 'USD', network: 'Linea', contract_address: null, metadata: { provider: 'Linea RPC' } }, prefer: 'return=representation' }))[0].id
}

const dates = weeklyDates(fromDate, toDate)
const prices = await ethPrices(dates)
const latestNumber = Number.parseInt(await rpc('eth_blockNumber', []), 16)
const latestBlock = await block(latestNumber)
let lowerBlock = await block(1)
const blockByDate = new Map()
for (const date of dates) {
  const target = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
  if (target >= latestBlock.timestamp) throw new Error(`${date} is newer than the latest finalized Linea block`)
  lowerBlock = await blockAtOrBefore(target, lowerBlock, latestBlock)
  blockByDate.set(date, lowerBlock)
  console.log(`${date} Linea block ${lowerBlock.number}`)
}

const checkpointQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, chain_name: `eq.${chainName}`, snapshot_date: `gte.${fromDate}`, select: 'wallet_hash,snapshot_date,status' })
const existingCheckpoints = await supabase(`/rest/v1/crypto_backfill_checkpoints?${checkpointQuery}`)
const completed = new Set(existingCheckpoints.filter((row) => row.status === 'success').map((row) => `${row.wallet_hash}:${row.snapshot_date}`))
const accounts = new Map()
for (const address of addresses) accounts.set(address, await ensureAccount(address))
const assetId = await ensureEthAsset()
let completedWeeks = 0
let rowsWritten = 0

for (const date of dates) {
  const price = prices.get(date)
  if (!price) throw new Error(`Missing ETH price for ${date}`)
  const blockForDate = blockByDate.get(date)
  for (const address of addresses) {
    const walletHash = hash(address.toLowerCase())
    if (completed.has(`${walletHash}:${date}`)) continue
    const rawBalance = await rpc('eth_getBalance', [address, `0x${blockForDate.number.toString(16)}`])
    const quantity = Number(BigInt(rawBalance)) / 1e18
    const value = quantity * price
    const sourceKey = `backfill:${walletHash}:${chainName}:${hash('native')}`
    const rowFilter = new URLSearchParams({ owner_id: `eq.${ownerId}`, snapshot_date: `eq.${date}`, source_key: `eq.${sourceKey}` })
    if (value >= minimumValue) {
      await supabase('/rest/v1/position_snapshots?on_conflict=owner_id,snapshot_date,source_key', { method: 'POST', body: { owner_id: ownerId, snapshot_date: date, captured_at: new Date().toISOString(), source_key: sourceKey, account_id: accounts.get(address), asset_id: assetId, quantity, price_usd: price, value_usd: value, cost_basis_usd: null, metadata: { snapshot_kind: 'reconstructed', balance_provider: 'Linea public archive RPC', price_provider: 'Binance ETHUSDT daily close', wallet_hash: walletHash, chain_name: chainName, block_number: blockForDate.number } }, prefer: 'resolution=merge-duplicates,return=minimal' })
      rowsWritten += 1
    } else {
      await supabase(`/rest/v1/position_snapshots?${rowFilter}`, { method: 'DELETE' })
    }
    await supabase('/rest/v1/crypto_backfill_checkpoints?on_conflict=owner_id,wallet_hash,chain_name,snapshot_date', { method: 'POST', body: { owner_id: ownerId, wallet_hash: walletHash, chain_name: chainName, snapshot_date: date, status: 'success', records_written: value >= minimumValue ? 1 : 0, message: null, completed_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' })
    completedWeeks += 1
    console.log(`${date} Linea-only ${address.slice(0, 6)}…: ${value >= minimumValue ? `${quantity.toFixed(6)} ETH · $${value.toFixed(2)} retained` : `below $${minimumValue} · not stored (not the wallet total)`}`)
  }
}

console.log(JSON.stringify({ chain: chainName, from: fromDate, to: toDate, wallets: addresses.length, completed_weeks: completedWeeks, snapshot_rows_written: rowsWritten }, null, 2))
