#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const argValue = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const fromDate = argValue("from", "2018-01-01");
const toDate = argValue("to", new Date().toISOString().slice(0, 10));
const minimumValue = Number(argValue("minimum-value", "100"));
const delayMs = Number(process.env.GOLDRUSH_DELAY_MS || 250);
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseKeyFile(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
  }));
}

async function goldRushKey() {
  if (process.env.GOLDRUSH_API_KEY?.trim()) return process.env.GOLDRUSH_API_KEY.trim();
  if (!process.env.GOLDRUSH_KEY_FILE?.trim()) throw new Error("Missing GOLDRUSH_API_KEY or GOLDRUSH_KEY_FILE");
  const values = parseKeyFile(await fs.readFile(process.env.GOLDRUSH_KEY_FILE.trim(), "utf8"));
  if (!values.GOLDRUSH_API_KEY) throw new Error("GoldRush key file must contain GOLDRUSH_API_KEY");
  return values.GOLDRUSH_API_KEY;
}

const apiKey = await goldRushKey();
async function goldRush(pathname) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`https://api.covalenthq.com/v1${pathname}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = await response.json().catch(() => ({}));
    if (response.ok && !body.error) return body.data;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) throw new Error(`GoldRush ${response.status}: ${body.error_message || body.error_code || "request failed"}`);
    await sleep(1000 * 2 ** attempt);
  }
}

function weeklyDates(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const limit = new Date(`${end}T00:00:00Z`);
  while (cursor <= limit) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return dates;
}

const addresses = required("PORTFOLIO_EVM_ADDRESSES").split(",").map((value) => value.trim()).filter(Boolean);
const [chainsData, activities] = await Promise.all([
  goldRush("/chains/"),
  Promise.all(addresses.map((address) => goldRush(`/address/${address}/activity/`))),
]);
const chainCapabilities = new Map((chainsData.items || []).map((chain) => [String(chain.name), chain]));
const configuredChains = process.env.GOLDRUSH_CHAIN_NAMES?.split(",").map((value) => value.trim()).filter(Boolean);
const plans = [];
for (let index = 0; index < addresses.length; index += 1) {
  const activity = activities[index]?.items || [];
  const activeNames = configuredChains?.length ? configuredChains : activity.map((item) => item.name || item.chain_name).filter(Boolean);
  for (const chainName of [...new Set(activeNames)]) {
    const capability = chainCapabilities.get(chainName);
    if (capability && capability.is_historical_balances_supported === false) continue;
    const active = activity.find((item) => (item.name || item.chain_name) === chainName);
    const firstSeen = active?.first_seen_at ? String(active.first_seen_at).slice(0, 10) : fromDate;
    const start = firstSeen > fromDate ? firstSeen : fromDate;
    plans.push({ address: addresses[index], walletHash: hash(addresses[index].toLowerCase()), chainName, dates: weeklyDates(start, toDate) });
  }
}

console.log(JSON.stringify({ mode: dryRun ? "plan" : "write", from: fromDate, to: toDate, minimum_value_usd: minimumValue, wallets: addresses.length, chains: plans.map((plan) => ({ wallet: `${plan.address.slice(0, 6)}…${plan.address.slice(-4)}`, chain: plan.chainName, weeks: plan.dates.length })), total_requests: plans.reduce((sum, plan) => sum + plan.dates.length, 0) }, null, 2));
if (dryRun) process.exit(0);

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const supabaseKey = required("SUPABASE_SECRET_KEY");
const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" };
async function supabase(endpoint, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${supabaseUrl}${endpoint}`, { method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase ${method} ${response.status}: ${data?.message || text.slice(0, 160)}`);
  return data;
}
let ownerId = process.env.PORTFOLIO_OWNER_ID?.trim();
if (!ownerId) {
  const email = required("PORTFOLIO_OWNER_EMAIL").toLowerCase();
  const users = await supabase("/auth/v1/admin/users?page=1&per_page=100");
  ownerId = users.users.find((user) => user.email?.toLowerCase() === email)?.id;
  if (!ownerId) throw new Error("Configured portfolio owner was not found");
}
const accountCache = new Map();
const assetCache = new Map();
async function ensureAccount(address, chainName) {
  const key = `${address}|${chainName}`;
  if (accountCache.has(key)) return accountCache.get(key);
  const name = `Wallet · ${address} · ${chainName}`;
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, name: `eq.${name}`, institution: "eq.GoldRush", select: "id" });
  const existing = await supabase(`/rest/v1/accounts?${query}`);
  const id = existing[0]?.id || (await supabase("/rest/v1/accounts", { method: "POST", body: { owner_id: ownerId, name, institution: "GoldRush", account_type: "wallet", currency: "USD", source: "goldrush-backfill" }, prefer: "return=representation" }))[0].id;
  accountCache.set(key, id);
  return id;
}
async function ensureAsset(item, chainName) {
  const symbol = String(item.contract_ticker_symbol || "TOKEN").slice(0, 32).toUpperCase();
  const contract = String(item.contract_address || "native");
  const key = `${symbol}|${chainName}|${contract}`;
  if (assetCache.has(key)) return assetCache.get(key);
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, symbol: `eq.${symbol}`, select: "id,network,contract_address" });
  const candidates = await supabase(`/rest/v1/assets?${query}`);
  const existing = candidates.find((asset) => asset.network === chainName && (asset.contract_address || "native") === contract);
  const stable = ["USDC", "USDT", "DAI", "USDE", "FRAX", "LUSD", "GHO"].includes(symbol);
  const gold = ["XAUT", "XAUT0", "PAXG"].includes(symbol);
  const id = existing?.id || (await supabase("/rest/v1/assets", { method: "POST", body: { owner_id: ownerId, symbol, name: item.contract_name || symbol, asset_class: stable ? "stablecoin" : gold ? "gold" : "crypto", currency: "USD", network: chainName, contract_address: contract === "native" ? null : contract, metadata: { provider: "GoldRush" } }, prefer: "return=representation" }))[0].id;
  assetCache.set(key, id);
  return id;
}

let completed = 0;
let written = 0;
for (const plan of plans) {
  const accountId = await ensureAccount(plan.address, plan.chainName);
  for (const date of plan.dates) {
    const checkpointQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, wallet_hash: `eq.${plan.walletHash}`, chain_name: `eq.${plan.chainName}`, snapshot_date: `eq.${date}`, status: "eq.success", select: "id" });
    if (!force && (await supabase(`/rest/v1/crypto_backfill_checkpoints?${checkpointQuery}`)).length) continue;
    try {
      const params = new URLSearchParams({ "quote-currency": "USD", nft: "false", "no-spam": "true", date });
      const data = await goldRush(`/${plan.chainName}/address/${plan.address}/historical_balances/?${params}`);
      const items = (data.items || []).filter((item) => Number(item.quote || 0) >= minimumValue);
      const rows = [];
      for (const item of items) {
        const decimals = Number(item.contract_decimals || 0);
        const quantity = Number(item.balance || 0) / 10 ** decimals;
        const value = Number(item.quote || 0);
        const contract = String(item.contract_address || "native");
        rows.push({ owner_id: ownerId, snapshot_date: date, captured_at: new Date().toISOString(), source_key: `backfill:${plan.walletHash}:${plan.chainName}:${hash(contract)}`, account_id: accountId, asset_id: await ensureAsset(item, plan.chainName), quantity, price_usd: Number(item.quote_rate || (quantity ? value / quantity : 0)), value_usd: value, cost_basis_usd: null, metadata: { snapshot_kind: "reconstructed", provider: "GoldRush", wallet_hash: plan.walletHash, chain_name: plan.chainName } });
      }
      const staleQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, snapshot_date: `eq.${date}`, source_key: `like.backfill:${plan.walletHash}:${plan.chainName}:%`, select: "id,source_key" });
      const existing = await supabase(`/rest/v1/position_snapshots?${staleQuery}`);
      const keep = new Set(rows.map((row) => row.source_key));
      for (const stale of existing.filter((row) => !keep.has(row.source_key))) await supabase(`/rest/v1/position_snapshots?id=eq.${stale.id}`, { method: "DELETE" });
      if (rows.length) await supabase("/rest/v1/position_snapshots?on_conflict=owner_id,snapshot_date,source_key", { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
      await supabase("/rest/v1/crypto_backfill_checkpoints?on_conflict=owner_id,wallet_hash,chain_name,snapshot_date", { method: "POST", body: { owner_id: ownerId, wallet_hash: plan.walletHash, chain_name: plan.chainName, snapshot_date: date, status: "success", records_written: rows.length, message: null, completed_at: new Date().toISOString() }, prefer: "resolution=merge-duplicates,return=minimal" });
      completed += 1;
      written += rows.length;
      console.log(`${date} ${plan.chainName} ${plan.address.slice(0, 6)}…: ${rows.length} assets >= $${minimumValue}`);
    } catch (error) {
      await supabase("/rest/v1/crypto_backfill_checkpoints?on_conflict=owner_id,wallet_hash,chain_name,snapshot_date", { method: "POST", body: { owner_id: ownerId, wallet_hash: plan.walletHash, chain_name: plan.chainName, snapshot_date: date, status: "failed", records_written: 0, message: String(error.message).slice(0, 300), completed_at: new Date().toISOString() }, prefer: "resolution=merge-duplicates,return=minimal" });
      console.error(`${date} ${plan.chainName}: ${error.message}`);
    }
    await sleep(delayMs);
  }
}
console.log(JSON.stringify({ completed_weeks: completed, snapshot_rows_written: written }, null, 2));
