#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
const shouldRun = (source) => !only || only.has(source);
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const number = (value) => Number(String(value ?? "").replaceAll(",", "")) || 0;
const round = (value, digits = 2) => Number(value.toFixed(digits));
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const now = new Date().toISOString();
const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: process.env.PORTFOLIO_TIME_ZONE || "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(new Date()).map((part) => [part.type, part.value]));
const snapshotDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

const decodeXml = (value) => value
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'");

function unzipText(xlsxPath, entry) {
  return execFileSync("unzip", ["-p", xlsxPath, entry], { encoding: "utf8", maxBuffer: 30_000_000 });
}

function parseXlsxRows(xlsxPath) {
  const read = (entry) => unzipText(xlsxPath, entry);
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((match) => decodeXml([...match[1].matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join("")));
  const names = [...read("xl/workbook.xml").matchAll(/<sheet name="([^"]+)"/g)].map((match) => decodeXml(match[1]));
  return Object.fromEntries(names.map((name, index) => {
    const xml = read(`xl/worksheets/sheet${index + 1}.xml`);
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c[^>]*r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
        const [, column, attributes, body] = cellMatch;
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
        const columnIndex = [...column].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
        cells[columnIndex] = attributes.includes('t="s"') ? shared[Number(raw)] : raw;
      }
      return cells;
    });
    return [name, rows];
  }));
}

async function withXlsxFromArchive(sourcePath, callback) {
  if (sourcePath.toLowerCase().endsWith(".xlsx")) return callback(sourcePath);
  const entries = execFileSync("unzip", ["-Z1", sourcePath], { encoding: "utf8" }).trim().split("\n");
  const entry = entries.find((item) => item.toLowerCase().endsWith(".xlsx"));
  if (!entry) throw new Error("XTB archive contains no .xlsx file");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-xtb-"));
  const tempPath = path.join(tempDir, "export.xlsx");
  try {
    await fs.writeFile(tempPath, execFileSync("unzip", ["-p", sourcePath, entry], { maxBuffer: 30_000_000 }));
    return await callback(tempPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${data?.message ?? "request failed"}`);
  return data;
}

async function fetchJsonWithRetry(url, options = {}, retries = 4) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      if (!String(error.message).startsWith("429 ") || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 8_000 * (attempt + 1)));
    }
  }
}

async function loadFx() {
  const rows = await fetchJson("https://api.frankfurter.dev/v2/rates?base=USD&quotes=INR,GBP,AED");
  const rates = Object.fromEntries(rows.map((row) => [row.quote, { rate: row.rate, date: row.date }]));
  for (const currency of ["INR", "GBP", "AED"]) if (!rates[currency]?.rate) throw new Error(`FX response missing ${currency}`);
  return rates;
}

async function loadRabby(addresses) {
  const positions = [];
  const owned = new Set(addresses.map((address) => address.toLowerCase()));
  const headers = { "X-Client": "Rabby", "X-Version": "0.9.69" };
  for (let walletIndex = 0; walletIndex < addresses.length; walletIndex += 1) {
    if (walletIndex) await new Promise((resolve) => setTimeout(resolve, 1400));
    const data = await fetchJsonWithRetry(`https://api.rabby.io/v1/user/total_balance?id=${encodeURIComponent(addresses[walletIndex])}&is_core=true`, { headers });
    const chains = (data.chain_list ?? []).filter((chain) => number(chain.usd_value) >= 0.01);
    for (const chain of chains) {
      const chainId = String(chain.id ?? chain.community_id ?? "unknown");
      const chainName = chain.name || chainId;
      const account = { name: `Wallet ${walletIndex + 1} · ${chainName}`, institution: "Rabby", account_type: "wallet", currency: "USD", source: "rabby" };
      await new Promise((resolve) => setTimeout(resolve, 850));
      const tokens = await fetchJsonWithRetry(`https://api.rabby.io/v1/user/token_list?id=${encodeURIComponent(addresses[walletIndex])}&chain_id=${encodeURIComponent(chainId)}&is_all=false`, { headers });
      let history = { history_list: [] };
      if (tokens.some((token) => number(token.usd_value ?? token.amount * token.price) >= 100)) {
        await new Promise((resolve) => setTimeout(resolve, 850));
        history = await fetchJsonWithRetry(`https://api.rabby.io/v1/user/history_list?id=${encodeURIComponent(addresses[walletIndex])}&chain_id=${encodeURIComponent(chainId)}&page_count=100`, { headers });
      }
      const receiptStats = new Map();
      for (const event of history.history_list ?? []) {
        for (const receipt of event.receives ?? []) {
          if (owned.has(String(receipt.from_addr).toLowerCase()) || !number(receipt.price)) continue;
          const current = receiptStats.get(receipt.token_id) ?? { amount: 0, value: 0 };
          current.amount += number(receipt.amount);
          current.value += number(receipt.amount) * number(receipt.price);
          receiptStats.set(receipt.token_id, current);
        }
      }
      let directValue = 0;
      for (const token of tokens.filter((item) => number(item.usd_value ?? item.amount * item.price) >= 0.01)) {
        const value = number(token.usd_value ?? token.amount * token.price);
        const acquisition = receiptStats.get(token.id);
        const estimatedPrice = acquisition?.amount ? acquisition.value / acquisition.amount : null;
        directValue += value;
        const stable = ["USDT", "USDC", "DAI", "USDE", "FRAX", "LUSD", "GHO"].includes(String(token.symbol).toUpperCase());
        positions.push({
          account,
          asset: { symbol: String(token.symbol || token.optimized_symbol || "TOKEN").slice(0, 32).toUpperCase(), name: token.name || token.symbol, asset_class: stable ? "stablecoin" : "crypto", currency: "USD", network: chainId, contract_address: String(token.id), metadata: { rabby_verified: token.is_verified, rabby_core: token.is_core } },
          quantity: number(token.amount),
          price_usd: number(token.price),
          value_usd: round(value),
          cost_basis_usd: estimatedPrice ? round(number(token.amount) * estimatedPrice) : null,
          source_key: `rabby:${hash(addresses[walletIndex])}:${chainId}:${hash(String(token.id))}`,
          metadata: { wallet_index: walletIndex + 1, chain_id: chainId, estimated_acquisition_price_usd: estimatedPrice ? round(estimatedPrice, 8) : null, cost_basis_method: estimatedPrice ? "weighted historical price of recent external receipts" : null },
        });
      }
      const residual = number(chain.usd_value) - directValue;
      if (residual >= 0.01) positions.push({
        account,
        asset: { symbol: `DEFI-${chainId}`.slice(0, 32).toUpperCase(), name: `${chainName} DeFi and protocol positions`, asset_class: "crypto", currency: "USD", network: chainId, contract_address: null, metadata: { valuation: "Rabby chain total less direct wallet tokens" } },
        quantity: 1,
        price_usd: residual,
        value_usd: round(residual),
        source_key: `rabby:${hash(addresses[walletIndex])}:${chainId}:defi`,
        metadata: { wallet_index: walletIndex + 1, chain_id: chainId },
      });
    }
  }
  return positions;
}

function parseKeyFile(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
  }));
}

async function loadBinance(keyFile) {
  const credentials = keyFile ? parseKeyFile(await fs.readFile(keyFile, "utf8")) : process.env;
  const apiKey = credentials.BINANCE_API_KEY;
  const secret = credentials.BINANCE_API_SECRET;
  if (!apiKey || !secret) throw new Error("Binance key file is missing required variables");
  const signed = async (pathname, method = "GET", extra = {}) => {
    const params = new URLSearchParams({ ...extra, recvWindow: "10000", timestamp: String(Date.now()) });
    params.set("signature", createHmac("sha256", secret).update(params.toString()).digest("hex"));
    const url = `https://api.binance.com${pathname}?${params}`;
    return fetchJson(url, { method, headers: { "X-MBX-APIKEY": apiKey } });
  };
  const [spot, funding, flexible, locked, tickerRows] = await Promise.all([
    signed("/api/v3/account", "GET", { omitZeroBalances: "true" }),
    signed("/sapi/v1/asset/get-funding-asset", "POST"),
    signed("/sapi/v1/simple-earn/flexible/position", "GET", { size: "100" }),
    signed("/sapi/v1/simple-earn/locked/position", "GET", { size: "100" }),
    fetchJson("https://api.binance.com/api/v3/ticker/price"),
  ]);
  const prices = new Map(tickerRows.map((row) => [row.symbol, number(row.price)]));
  const quantities = new Map();
  const add = (asset, amount) => quantities.set(asset, (quantities.get(asset) ?? 0) + number(amount));
  for (const row of spot.balances ?? []) {
    if (row.asset.startsWith("LD")) continue;
    add(row.asset, number(row.free) + number(row.locked));
  }
  for (const row of funding ?? []) add(row.asset, row.free);
  for (const row of flexible.rows ?? []) add(row.asset, row.totalAmount);
  for (const row of locked.rows ?? []) add(row.asset, row.amount ?? row.totalAmount);
  const priceUsd = (asset) => {
    if (["USDT", "USDC", "FDUSD", "DAI", "TUSD", "USD"].includes(asset)) return 1;
    const direct = prices.get(`${asset}USDT`);
    if (direct) return direct;
    const btcCross = prices.get(`${asset}BTC`) * prices.get("BTCUSDT");
    return btcCross || 0;
  };
  return [...quantities.entries()].map(([asset, quantity]) => {
    const price = priceUsd(asset);
    const stable = ["USDT", "USDC", "FDUSD", "DAI", "TUSD"].includes(asset);
    return {
      account: { name: "Binance", institution: "Binance", account_type: "exchange", currency: "USD", source: "binance" },
      asset: { symbol: asset, name: asset, asset_class: stable ? "stablecoin" : "crypto", currency: "USD", network: "binance", contract_address: null, metadata: {} },
      quantity,
      price_usd: price,
      value_usd: round(quantity * price),
      source_key: `binance:${asset}`,
      metadata: { pricing_pair: price ? `${asset}/USD` : null },
    };
  }).filter((position) => position.value_usd >= 0.01 || position.quantity > 0);
}

async function loadWio(csvPaths, fx) {
  const latest = new Map();
  for (const csvPath of csvPaths) {
    const rows = parseCsv(await fs.readFile(csvPath, "utf8"));
    const headers = rows.shift();
    const ix = Object.fromEntries(headers.map((name, index) => [name, index]));
    for (const row of rows) {
      const identity = `${row[ix["Account name"]]}|${row[ix["Account currency"]]}`;
      const date = new Date(row[ix.Date]);
      const candidate = { identity, currency: row[ix["Account currency"]], balance: number(row[ix.Balance]), date };
      if (!latest.has(identity) || date > latest.get(identity).date) latest.set(identity, candidate);
    }
  }
  const counters = new Map();
  return [...latest.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.identity.localeCompare(b.identity)).map((row) => {
    const accountNumber = (counters.get(row.currency) ?? 0) + 1;
    counters.set(row.currency, accountNumber);
    const price = row.currency === "USD" ? 1 : 1 / fx[row.currency].rate;
    return {
      account: { name: `Wio ${row.currency} ${accountNumber}`, institution: "Wio", account_type: "bank", currency: row.currency, source: "wio-export" },
      asset: { symbol: row.currency, name: `${row.currency} cash`, asset_class: "cash", currency: row.currency, network: null, contract_address: null, metadata: {} },
      quantity: row.balance,
      price_usd: price,
      value_usd: round(row.balance * price),
      source_key: `wio:${hash(row.identity)}`,
      as_of: row.date.toISOString(),
      metadata: { export_as_of: row.date.toISOString().slice(0, 10), fx_date: row.currency === "USD" ? null : fx[row.currency].date },
    };
  });
}

async function loadWioStocks(jsonPath) {
  const rows = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  return rows.map((row) => ({
    account: { name: "Wio Securities", institution: "Wio", account_type: "brokerage", currency: "USD", source: "wio-screenshot" },
    asset: { symbol: row.symbol, name: row.name, asset_class: row.asset_class || "equity", currency: "USD", network: "wio", contract_address: null, metadata: { source: "Wio app screenshot" } },
    quantity: row.quantity,
    price_usd: row.quantity ? row.value_usd / row.quantity : 0,
    value_usd: row.value_usd,
    cost_basis_usd: row.cost_basis_usd,
    source_key: `wio-stocks:${row.symbol}`,
    metadata: { unrealized_profit_usd: round(row.value_usd - row.cost_basis_usd), source: "Wio app screenshot" },
  }));
}

async function loadXtb(sourcePath) {
  return withXlsxFromArchive(sourcePath, async (xlsxPath) => {
    const sheets = parseXlsxRows(xlsxPath);
    const open = sheets["Open Positions"];
    const cashOps = sheets["Cash Operations"];
    if (!open || !cashOps) throw new Error("XTB workbook is missing expected sheets");
    const reportDateSerial = number(open[2]?.[1]);
    const asOf = new Date(Date.UTC(1899, 11, 30) + reportDateSerial * 86_400_000).toISOString();
    const account = { name: "XTB", institution: "XTB", account_type: "brokerage", currency: "USD", source: "xtb-export" };
    const assetFor = (ticker, name) => ({ symbol: String(ticker).replace(/\.US$/, ""), name: name || ticker, asset_class: "equity", currency: "USD", network: "xtb", contract_address: null, metadata: { export_ticker: ticker } });
    const equities = open.slice(8).filter((row) => row[3] === "STOCK" && !row[4]).map((row) => {
      const quantity = number(row[5]);
      const value = number(row[6]);
      const profit = number(row[13]);
      const symbol = String(row[2]).replace(/\.US$/, "");
      return {
        account,
        asset: assetFor(row[2], row[1]),
        quantity,
        price_usd: quantity ? value / quantity : 0,
        value_usd: round(value),
        cost_basis_usd: round(value - profit),
        source_key: `xtb:equity:${symbol}`,
        as_of: asOf,
        metadata: { unrealized_profit_usd: round(profit) },
      };
    });
    const cashHeader = cashOps.findIndex((row) => row[0] === "Type" && row[5] === "Amount");
    const reportedCash = cashOps.find((row) => row[0] === "Total");
    const cash = round(reportedCash ? number(reportedCash[5]) : cashOps.slice(cashHeader + 1).filter((row) => row[0] !== "Total").reduce((sum, row) => sum + number(row[5]), 0));
    equities.push({
      account,
      asset: { symbol: "USD", name: "US dollar", asset_class: "cash", currency: "USD", network: null, contract_address: null, metadata: {} },
      quantity: cash,
      price_usd: 1,
      value_usd: cash,
      source_key: "xtb:cash",
      as_of: asOf,
      metadata: { derived_from: "sum of cash operations" },
    });
    const transactions = [];
    for (const row of cashOps.slice(cashHeader + 1)) {
      if (!number(row[4]) || !row[0]) continue;
      const match = String(row[7] ?? "").match(/(?:OPEN|CLOSE) (?:BUY|SELL) (?:\S+ )?([\d.]+) @ ([\d.]+)/i);
      transactions.push({
        external_ref: `cash:${row[6] || hash(row.join("|"))}`,
        account,
        asset: row[2] ? assetFor(row[2], row[1]) : null,
        event_time: new Date(Date.UTC(1899, 11, 30) + number(row[4]) * 86_400_000).toISOString(),
        event_type: row[0],
        quantity: match ? number(match[1]) : null,
        price_usd: match ? number(match[2]) : null,
        amount_usd: round(number(row[5])),
        realized_pnl_usd: null,
        metadata: { category: row[3] || null, product: row[8] || null },
      });
    }
    const closed = sheets["Closed Positions"] ?? [];
    const closedHeader = closed.findIndex((row) => row[0] === "Instrument" && row[1] === "Ticker");
    for (const row of closed.slice(closedHeader + 1)) {
      if (!row[1] || !number(row[8])) continue;
      transactions.push({
        external_ref: `closed:${row[23] || hash(row.join("|"))}:${row[8]}`,
        account,
        asset: assetFor(row[1], row[0]),
        event_time: new Date(Date.UTC(1899, 11, 30) + number(row[8]) * 86_400_000).toISOString(),
        event_type: "Closed position",
        quantity: number(row[4]),
        price_usd: number(row[7]),
        amount_usd: round(number(row[13])),
        realized_pnl_usd: round(number(row[10])),
        metadata: { side: row[3] || null, open_price_usd: number(row[5]), purchase_value_usd: number(row[12]) },
      });
    }
    return { positions: equities, transactions };
  });
}

function summarize(sourcePositions) {
  return Object.fromEntries(Object.entries(sourcePositions).map(([source, positions]) => [source, {
    records: positions.length,
    value_usd: round(positions.reduce((sum, position) => sum + position.value_usd, 0)),
  }]));
}

const fx = await loadFx();
const sourcePositions = {};
const sourceErrors = {};
let xtbTransactions = [];
async function captureSource(source, loader) {
  try { return await loader(); }
  catch (error) {
    sourceErrors[source] = String(error.message).replace(/0x[a-fA-F0-9]{40}/g, "[wallet]");
    return null;
  }
}
if (shouldRun("rabby")) {
  const result = await captureSource("rabby", () => loadRabby(required("PORTFOLIO_EVM_ADDRESSES").split(",").map((value) => value.trim()).filter(Boolean)));
  if (result) sourcePositions.rabby = result;
}
if (shouldRun("binance")) {
  const result = await captureSource("binance", () => loadBinance(process.env.BINANCE_KEY_FILE?.trim()));
  if (result) sourcePositions.binance = result;
}
if (shouldRun("wio")) {
  const result = await captureSource("wio", () => loadWio(required("WIO_CSV_PATHS").split(path.delimiter).filter(Boolean), fx));
  if (result) sourcePositions.wio = result;
}
if (shouldRun("wio-stocks") && process.env.WIO_STOCKS_JSON_PATH?.trim()) {
  const result = await captureSource("wio-stocks", () => loadWioStocks(process.env.WIO_STOCKS_JSON_PATH.trim()));
  if (result) sourcePositions["wio-stocks"] = result;
}
if (shouldRun("xtb")) {
  const xtb = await captureSource("xtb", () => loadXtb(required("XTB_EXPORT_PATH")));
  if (xtb) {
    sourcePositions.xtb = xtb.positions;
    xtbTransactions = xtb.transactions;
  }
}

if (dryRun) {
  console.log(JSON.stringify({ as_of: now, fx, sources: summarize(sourcePositions), source_errors: sourceErrors, xtb_history_records: xtbTransactions.length }, null, 2));
  process.exit(0);
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const supabaseKey = required("SUPABASE_SECRET_KEY");
const ownerEmail = process.env.PORTFOLIO_OWNER_EMAIL?.trim().toLowerCase();
const configuredOwnerId = process.env.PORTFOLIO_OWNER_ID?.trim();
const baseHeaders = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" };
async function supabase(endpoint, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${supabaseUrl}${endpoint}`, { method, headers: { ...baseHeaders, ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase ${method} ${endpoint}: ${response.status} ${data?.message ?? text.slice(0, 200)}`);
  return data;
}
let ownerId = configuredOwnerId;
if (!ownerId) {
  if (!ownerEmail) throw new Error("Missing PORTFOLIO_OWNER_ID or PORTFOLIO_OWNER_EMAIL");
  const users = await supabase("/auth/v1/admin/users?page=1&per_page=100");
  const owner = users.users.find((user) => user.email?.toLowerCase() === ownerEmail);
  if (!owner) throw new Error(`No Supabase user found for the configured importer identity`);
  ownerId = owner.id;
}
const accountCache = new Map();
const assetCache = new Map();

async function ensureAccount(account) {
  const cacheKey = `${account.name}|${account.institution}`;
  if (accountCache.has(cacheKey)) return accountCache.get(cacheKey);
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, name: `eq.${account.name}`, institution: `eq.${account.institution}`, select: "id" });
  const existing = await supabase(`/rest/v1/accounts?${query}`);
  const id = existing[0]?.id ?? (await supabase("/rest/v1/accounts", { method: "POST", body: { owner_id: ownerId, ...account }, prefer: "return=representation" }))[0].id;
  accountCache.set(cacheKey, id);
  return id;
}

async function ensureAsset(asset) {
  const cacheKey = `${asset.symbol}|${asset.network ?? ""}|${asset.contract_address ?? ""}`;
  if (assetCache.has(cacheKey)) return assetCache.get(cacheKey);
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, symbol: `eq.${asset.symbol}`, select: "id,network,contract_address" });
  const candidates = await supabase(`/rest/v1/assets?${query}`);
  const existing = candidates.find((item) => (item.network ?? null) === (asset.network ?? null) && (item.contract_address ?? null) === (asset.contract_address ?? null));
  const id = existing?.id ?? (await supabase("/rest/v1/assets", { method: "POST", body: { owner_id: ownerId, ...asset }, prefer: "return=representation" }))[0].id;
  assetCache.set(cacheKey, id);
  return id;
}

async function replaceSource(source, positions) {
  const [run] = await supabase("/rest/v1/sync_runs", { method: "POST", body: { owner_id: ownerId, source, status: "running", records_seen: positions.length }, prefer: "return=representation" });
  try {
    const rows = [];
    for (const position of positions) {
      rows.push({
        owner_id: ownerId,
        account_id: await ensureAccount(position.account),
        asset_id: await ensureAsset(position.asset),
        quantity: position.quantity,
        price_usd: position.price_usd,
        value_usd: position.value_usd,
        cost_basis_usd: position.cost_basis_usd ?? null,
        source_key: position.source_key,
        as_of: position.as_of ?? now,
        metadata: position.metadata ?? {},
      });
    }
    if (rows.length) await supabase("/rest/v1/positions?on_conflict=owner_id,source_key", { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
    const existingQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, source_key: `like.${source}:%`, select: "id,source_key" });
    const existing = await supabase(`/rest/v1/positions?${existingQuery}`);
    const keep = new Set(rows.map((row) => row.source_key));
    for (const stale of existing.filter((row) => !keep.has(row.source_key))) {
      await supabase(`/rest/v1/positions?id=eq.${stale.id}`, { method: "DELETE" });
    }
    await supabase(`/rest/v1/sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "success", records_written: rows.length, finished_at: new Date().toISOString(), message: `${rows.length} current positions` }, prefer: "return=minimal" });
  } catch (error) {
    await supabase(`/rest/v1/sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "failed", finished_at: new Date().toISOString(), message: String(error.message).slice(0, 500) }, prefer: "return=minimal" });
    throw error;
  }
}

for (const [source, positions] of Object.entries(sourcePositions)) await replaceSource(source, positions);

if (sourcePositions["wio-stocks"]) {
  await supabase(`/rest/v1/positions?owner_id=eq.${ownerId}&source_key=eq.manual:wio:equity`, { method: "DELETE" });
}

if (xtbTransactions.length) {
  const rows = [];
  for (const transaction of xtbTransactions) {
    rows.push({
      owner_id: ownerId,
      source: "xtb",
      external_ref: transaction.external_ref,
      account_id: await ensureAccount(transaction.account),
      asset_id: transaction.asset ? await ensureAsset(transaction.asset) : null,
      event_time: transaction.event_time,
      event_type: transaction.event_type,
      quantity: transaction.quantity,
      price_usd: transaction.price_usd,
      amount_usd: transaction.amount_usd,
      realized_pnl_usd: transaction.realized_pnl_usd,
      metadata: transaction.metadata,
    });
  }
  for (let index = 0; index < rows.length; index += 100) {
    await supabase("/rest/v1/brokerage_transactions?on_conflict=owner_id,source,external_ref", { method: "POST", body: rows.slice(index, index + 100), prefer: "resolution=merge-duplicates,return=minimal" });
  }
}

for (const update of [
  { key: "india:inr", currency: "INR" },
  { key: "gbp:cash", currency: "GBP" },
]) {
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, source_key: `eq.${update.key}`, select: "id,quantity" });
  const [position] = await supabase(`/rest/v1/positions?${query}`);
  if (position) {
    const priceUsd = 1 / fx[update.currency].rate;
    await supabase(`/rest/v1/positions?id=eq.${position.id}`, { method: "PATCH", body: { price_usd: priceUsd, value_usd: round(number(position.quantity) * priceUsd), as_of: now, metadata: { fx_provider: "Frankfurter", fx_date: fx[update.currency].date } }, prefer: "return=minimal" });
  }
}

const positions = await supabase(`/rest/v1/positions?owner_id=eq.${ownerId}&select=id,source_key,account_id,asset_id,quantity,price_usd,value_usd,cost_basis_usd,metadata,assets(asset_class)`);
const totals = { total_value_usd: 0, cash_usd: 0, equities_usd: 0, crypto_usd: 0, alternatives_usd: 0, liabilities_usd: 0 };
for (const position of positions) {
  const value = number(position.value_usd);
  const assetClass = position.assets?.asset_class;
  totals.total_value_usd += value;
  if (["cash", "stablecoin"].includes(assetClass)) totals.cash_usd += value;
  else if (assetClass === "equity") totals.equities_usd += value;
  else if (["crypto", "nft"].includes(assetClass)) totals.crypto_usd += value;
  else if (["fixed_income", "gold", "alternative"].includes(assetClass)) totals.alternatives_usd += value;
  else if (assetClass === "liability") totals.liabilities_usd += value;
}
for (const key of Object.keys(totals)) totals[key] = round(totals[key]);
await supabase("/rest/v1/portfolio_snapshots?on_conflict=owner_id,snapshot_date", { method: "POST", body: { owner_id: ownerId, snapshot_date: snapshotDate, ...totals, metadata: { fx_provider: "Frankfurter", synced_sources: Object.keys(sourcePositions) } }, prefer: "resolution=merge-duplicates,return=minimal" });
const positionSnapshots = positions.map((position) => ({
  owner_id: ownerId,
  snapshot_date: snapshotDate,
  captured_at: now,
  source_key: position.source_key,
  account_id: position.account_id,
  asset_id: position.asset_id,
  quantity: position.quantity,
  price_usd: position.price_usd,
  value_usd: position.value_usd,
  cost_basis_usd: position.cost_basis_usd,
  metadata: position.metadata,
}));
for (let index = 0; index < positionSnapshots.length; index += 100) {
  await supabase("/rest/v1/position_snapshots?on_conflict=owner_id,snapshot_date,source_key", { method: "POST", body: positionSnapshots.slice(index, index + 100), prefer: "resolution=merge-duplicates,return=minimal" });
}
const existingSnapshotQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, snapshot_date: `eq.${snapshotDate}`, select: "id,source_key" });
const existingSnapshots = await supabase(`/rest/v1/position_snapshots?${existingSnapshotQuery}`);
const currentSnapshotKeys = new Set(positionSnapshots.map((position) => position.source_key));
for (const stale of existingSnapshots.filter((position) => !currentSnapshotKeys.has(position.source_key))) {
  await supabase(`/rest/v1/position_snapshots?id=eq.${stale.id}`, { method: "DELETE" });
}
console.log(JSON.stringify({ as_of: now, fx, sources: summarize(sourcePositions), source_errors: sourceErrors, xtb_history_records: xtbTransactions.length, snapshot_positions: positionSnapshots.length, portfolio: totals }, null, 2));
