#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const args = new Set(process.argv.slice(2));
if (args.has("--debank-key-stdin")) {
  const hideInput = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (hideInput) process.stdin.setRawMode(true);
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    process.env.DEBANK_ACCESS_KEY = line.trim();
    lines.close();
    break;
  }
  if (hideInput) process.stdin.setRawMode(false);
  if (!process.env.DEBANK_ACCESS_KEY) throw new Error("No DeBank access key received on stdin");
}
const dryRun = args.has("--dry-run");
const debug = args.has("--debug");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
const shouldRun = (source) => !only || only.has(source);
const serverCredentials = process.env.PORTFOLIO_SERVER_KEY_FILE?.trim()
  ? parseKeyFile(await fs.readFile(process.env.PORTFOLIO_SERVER_KEY_FILE.trim(), "utf8"))
  : {};
const required = (name) => {
  const value = process.env[name]?.trim() || serverCredentials[name]?.trim();
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
        const tokenSymbol = String(token.symbol).toUpperCase();
        const stable = ["USDT", "USDC", "DAI", "USDE", "FRAX", "LUSD", "GHO"].includes(tokenSymbol);
        const preciousMetal = ["XAUT", "XAUT0", "PAXG"].includes(tokenSymbol);
        positions.push({
          account,
          asset: { symbol: String(token.symbol || token.optimized_symbol || "TOKEN").slice(0, 32).toUpperCase(), name: token.name || token.symbol, asset_class: stable ? "stablecoin" : preciousMetal ? "gold" : "crypto", currency: "USD", network: chainId, contract_address: String(token.id), metadata: { rabby_verified: token.is_verified, rabby_core: token.is_core } },
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

async function loadDeBank(addresses, accessKey) {
  if (!accessKey) throw new Error("Missing DEBANK_ACCESS_KEY");
  const positions = [];
  const headers = { accept: "application/json", AccessKey: accessKey };
  const classify = (symbol) => {
    const normalized = String(symbol).toUpperCase();
    if (["USDT", "USDC", "DAI", "USDE", "FRAX", "LUSD", "GHO", "USD0", "USDT0"].includes(normalized)) return "stablecoin";
    if (["XAUT", "XAUT0", "PAXG"].includes(normalized)) return "gold";
    return "crypto";
  };
  const tokenAsset = (token, chain, assetClass) => ({
    symbol: String(token.optimized_symbol || token.display_symbol || token.symbol || "TOKEN").slice(0, 32).toUpperCase(),
    name: token.name || token.symbol || "Token",
    asset_class: assetClass || classify(token.symbol),
    currency: "USD",
    network: chain || token.chain || null,
    contract_address: String(token.id || "native"),
    metadata: { debank_verified: token.is_verified ?? null, debank_core: token.is_core ?? null, protocol_id: token.protocol_id || null },
  });
  for (const address of addresses) {
    const query = (pathname, params = {}) => fetchJson(`https://pro-openapi.debank.com${pathname}?${new URLSearchParams({ id: address, ...params })}`, { headers });
    const requests = await Promise.allSettled([
      query("/v1/user/all_token_list", { is_all: "false" }),
      query("/v1/user/all_complex_protocol_list"),
      query("/v1/user/all_nft_list", { is_all: "false" }),
      query("/v1/user/total_balance"),
    ]);
    const endpointNames = ["all_token_list", "all_complex_protocol_list", "all_nft_list", "total_balance"];
    const failures = requests.flatMap((result, index) => result.status === "rejected"
      ? [`${endpointNames[index]}: ${String(result.reason?.message || result.reason)}`]
      : []);
    if (failures.length) throw new Error(`DeBank request failures: ${failures.join(" | ")}`);
    const [tokens, protocols, nfts, totals] = requests.map((result) => result.value);
    const addressHash = hash(address.toLowerCase());
    const chainValues = new Map();
    const addChainValue = (chain, value) => chainValues.set(chain, (chainValues.get(chain) || 0) + value);
    for (const token of tokens ?? []) {
      // DeBank can include protocol-owned representations alongside direct wallet
      // balances. Protocol positions are recorded separately below.
      if (token.is_wallet === false) continue;
      const value = number(token.amount) * number(token.price);
      if (value < 0.01) continue;
      positions.push({
        account: { name: `Wallet · ${address} · ${token.chain}`, institution: "DeBank", account_type: "wallet", currency: "USD", source: "debank" },
        asset: tokenAsset(token, token.chain),
        quantity: number(token.amount),
        price_usd: number(token.price),
        value_usd: round(value),
        source_key: `debank:${addressHash}:${token.chain}:wallet:${hash(String(token.id))}`,
        metadata: { wallet: `${address.slice(0, 6)}…${address.slice(-4)}`, balance_type: "wallet_token" },
      });
      addChainValue(token.chain, value);
    }
    for (const protocol of protocols ?? []) {
      for (let itemIndex = 0; itemIndex < (protocol.portfolio_item_list ?? []).length; itemIndex += 1) {
        const item = protocol.portfolio_item_list[itemIndex];
        const account = { name: `Wallet · ${address} · ${protocol.name || protocol.id}`, institution: "DeBank", account_type: "defi", currency: "USD", source: "debank" };
        let detailedNet = 0;
        for (const token of item.asset_token_list ?? []) {
          const value = number(token.amount) * number(token.price);
          if (value < 0.01) continue;
          positions.push({
            account,
            asset: tokenAsset(token, protocol.chain),
            quantity: number(token.amount),
            price_usd: number(token.price),
            value_usd: round(value),
            source_key: `debank:${addressHash}:${protocol.chain}:protocol:${hash(`${protocol.id}:${itemIndex}:${token.id}:asset`)}`,
            metadata: { protocol_id: protocol.id, protocol_name: protocol.name, portfolio_type: item.name, balance_type: "protocol_asset" },
          });
          detailedNet += value;
        }
        for (const token of item.detail?.borrow_token_list ?? []) {
          const value = number(token.amount) * number(token.price);
          if (value < 0.01) continue;
          positions.push({
            account,
            asset: { ...tokenAsset(token, protocol.chain, "liability"), symbol: `${String(token.symbol || "TOKEN").toUpperCase()}-DEBT`.slice(0, 32), name: `${token.name || token.symbol} debt` },
            quantity: -number(token.amount),
            price_usd: number(token.price),
            value_usd: round(-value),
            source_key: `debank:${addressHash}:${protocol.chain}:protocol:${hash(`${protocol.id}:${itemIndex}:${token.id}:debt`)}`,
            metadata: { protocol_id: protocol.id, protocol_name: protocol.name, portfolio_type: item.name, balance_type: "protocol_debt" },
          });
          detailedNet -= value;
        }
        const authoritativeNet = number(item.stats?.net_usd_value);
        const residual = authoritativeNet - detailedNet;
        if (Math.abs(residual) >= 0.01) positions.push({
          account,
          asset: { symbol: `${residual < 0 ? "DEBT" : "DEFI"}-${hash(protocol.id).slice(0, 8)}`.toUpperCase(), name: `${protocol.name || protocol.id} unallocated net position`, asset_class: residual < 0 ? "liability" : "crypto", currency: "USD", network: protocol.chain, contract_address: null, metadata: { protocol_id: protocol.id } },
          quantity: residual,
          price_usd: 1,
          value_usd: round(residual),
          source_key: `debank:${addressHash}:${protocol.chain}:protocol:${hash(`${protocol.id}:${itemIndex}:residual`)}`,
          metadata: { protocol_id: protocol.id, protocol_name: protocol.name, portfolio_type: item.name, balance_type: "protocol_residual" },
        });
        addChainValue(protocol.chain, authoritativeNet);
      }
    }
    for (const chain of totals.chain_list ?? []) {
      const residual = number(chain.usd_value) - (chainValues.get(chain.id) || 0);
      if (residual < 0.01) continue;
      positions.push({
        account: { name: `Wallet · ${address} · ${chain.name || chain.id}`, institution: "DeBank", account_type: "wallet", currency: "USD", source: "debank" },
        asset: { symbol: `OTHER-${String(chain.id).toUpperCase()}`.slice(0, 32), name: `${chain.name || chain.id} unallocated wallet value`, asset_class: "crypto", currency: "USD", network: chain.id, contract_address: null, metadata: { valuation: "DeBank chain total less enumerated wallet and protocol positions" } },
        quantity: residual,
        price_usd: 1,
        value_usd: round(residual),
        source_key: `debank:${addressHash}:${chain.id}:residual`,
        metadata: { wallet: `${address.slice(0, 6)}…${address.slice(-4)}`, balance_type: "chain_residual" },
      });
    }
    for (const nft of nfts ?? []) {
      const quantity = number(nft.amount) || 1;
      const price = number(nft.usd_price);
      const value = quantity * price;
      if (value < 0.01) continue;
      positions.push({
        account: { name: `Wallet · ${address} · ${nft.chain}`, institution: "DeBank", account_type: "wallet", currency: "USD", source: "debank" },
        asset: { symbol: `NFT-${hash(`${nft.chain}:${nft.contract_id}:${nft.inner_id}`)}`.toUpperCase(), name: nft.name || `${nft.contract_name || "NFT"} #${nft.inner_id}`, asset_class: "nft", currency: "USD", network: nft.chain, contract_address: nft.contract_id, metadata: { collection_id: nft.collection_id || null, token_id: nft.inner_id } },
        quantity,
        price_usd: price,
        value_usd: round(value),
        source_key: `debank:${addressHash}:${nft.chain}:nft:${hash(String(nft.id))}`,
        metadata: { wallet: `${address.slice(0, 6)}…${address.slice(-4)}`, balance_type: "nft", detail_url: nft.detail_url || null },
      });
    }
  }
  return positions;
}

async function loadOneInch(addresses, apiKey) {
  if (!apiKey) throw new Error("Missing ONEINCH_API_KEY");
  const positions = [];
  const headers = { accept: "application/json", Authorization: `Bearer ${apiKey}` };
  const baseUrl = "https://api.1inch.com/portfolio/portfolio/v5.0";
  const chainNames = new Map([
    [1, "Ethereum"], [10, "Optimism"], [56, "BNB Chain"], [100, "Gnosis"],
    [137, "Polygon"], [324, "zkSync"], [480, "World Chain"], [999, "HyperEVM"],
    [1101, "Polygon zkEVM"], [8453, "Base"], [42161, "Arbitrum"], [43114, "Avalanche"],
    [59144, "Linea"], [81457, "Blast"],
  ]);
  const query = async (pathname, address) => {
    const params = new URLSearchParams({ addresses: address });
    const response = await fetchJson(`${baseUrl}${pathname}?${params}`, { headers });
    return response?.result ?? response;
  };
  const classify = (symbol) => {
    const normalized = String(symbol || "").toUpperCase();
    if (["USDT", "USDC", "DAI", "USDE", "FRAX", "LUSD", "GHO", "USD0", "USDT0"].includes(normalized)) return "stablecoin";
    if (["XAUT", "XAUT0", "PAXG"].includes(normalized)) return "gold";
    return "crypto";
  };
  for (const requestedAddress of addresses) {
    const [tokenRows, protocolRows] = await Promise.all([
      query("/tokens/snapshot", requestedAddress),
      query("/protocols/snapshot", requestedAddress),
    ]);
    for (const [kind, rows] of [["token", tokenRows], ["protocol", protocolRows]]) {
      if (!Array.isArray(rows)) throw new Error(`Unexpected 1inch ${kind} snapshot response`);
      for (const row of rows) {
      if (row.status != null && number(row.status) !== 1) continue;
      const rawValue = number(row.value_usd);
      if (Math.abs(rawValue) < 0.01) continue;
      const sign = number(row.asset_sign) < 0 ? -1 : 1;
      const value = rawValue < 0 ? rawValue : rawValue * sign;
      const underlying = Array.isArray(row.underlying_tokens) ? row.underlying_tokens.filter(Boolean) : [];
      const detail = underlying.length === 1 ? underlying[0] : {};
      const symbol = String(row.contract_symbol || detail.symbol || (kind === "protocol" ? "DEFI" : "TOKEN")).slice(0, 32).toUpperCase();
      const responseAddress = String(row.address || "");
      const address = /^0x0{40}$/i.test(responseAddress) || !responseAddress ? requestedAddress : responseAddress;
      const chainId = number(row.chain_id ?? row.chain);
      const network = chainNames.get(chainId) || String(chainId || "unknown");
      const amount = number(detail.amount ?? detail.balance ?? row.amount);
      const price = number(detail.price_to_usd ?? detail.price_usd ?? detail.price);
      const protocolName = row.protocol_group_name || row.protocol_sub_group_name || row.protocol_group_id || "DeFi";
      positions.push({
        account: {
          name: kind === "protocol" ? `Wallet · ${address} · ${protocolName}` : `Wallet · ${address} · ${network}`,
          institution: "1inch",
          account_type: kind === "protocol" ? "defi" : "wallet",
          currency: "USD",
          source: "oneinch",
        },
        asset: {
          symbol: sign < 0 ? `${symbol}-DEBT`.slice(0, 32) : symbol,
          name: row.contract_name || detail.name || (kind === "protocol" ? `${protocolName} position` : symbol),
          asset_class: sign < 0 ? "liability" : classify(symbol),
          currency: "USD",
          network,
          contract_address: row.contract_address || detail.contract_address || detail.address || null,
          metadata: { chain_id: chainId, protocol_id: row.protocol_group_id || null, protocol_type: row.protocol_type || null },
        },
        quantity: amount ? amount * sign : sign,
        price_usd: price || Math.abs(value),
        value_usd: round(value),
        source_key: `oneinch:${hash(address.toLowerCase())}:${chainId}:${kind}:${hash(String(row.index || `${row.contract_address}:${row.protocol_group_id}:${symbol}`))}`,
        metadata: {
          wallet_address: address.toLowerCase(),
          chain_id: chainId,
          contract_address: String(row.contract_address || detail.contract_address || detail.address || "native").toLowerCase(),
          wallet: address === "unknown" ? null : `${address.slice(0, 6)}…${address.slice(-4)}`,
          balance_type: kind === "protocol" ? "protocol_position" : "wallet_token",
          protocol_id: row.protocol_group_id || null,
          protocol_name: row.protocol_group_name || null,
          locked: row.locked ?? null,
          reward_tokens: row.reward_tokens || [],
        },
      });
      }
    }
  }
  return positions;
}

async function loadWatchedTokens(addresses, watchConfig) {
  if (!watchConfig) return [];
  const tokens = JSON.parse(watchConfig);
  if (!Array.isArray(tokens)) throw new Error("PORTFOLIO_WATCH_TOKENS_JSON must be a JSON array");
  const positions = [];
  const stablecoins = new Set(["USDT", "USDC", "DAI", "USDE", "FRAX", "LUSD", "GHO", "USD0", "USDT0"]);
  const goldTokens = new Set(["XAUT", "XAUT0", "PAXG"]);
  for (const token of tokens) {
    const contract = String(token.contract_address).toLowerCase();
    const priceResponse = token.binance_pair ? await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(token.binance_pair)}`) : null;
    const price = number(priceResponse?.price ?? token.price_usd);
    if (!price) throw new Error(`No price available for watched token ${token.symbol}`);
    for (const address of addresses) {
      const callData = `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
      const response = await fetchJson(token.rpc_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contract, data: callData }, "latest"] }) });
      if (response.error) throw new Error(`${token.symbol} RPC: ${response.error.message || "request failed"}`);
      const quantity = Number(BigInt(response.result || "0x0")) / 10 ** number(token.decimals);
      const value = quantity * price;
      if (value >= 0.01) {
        const symbol = String(token.symbol).slice(0, 32).toUpperCase();
        positions.push({
          account: { name: `Wallet · ${address} · ${token.network}`, institution: "Direct RPC", account_type: "wallet", currency: "USD", source: "oneinch" },
          asset: { symbol, name: token.name || symbol, asset_class: stablecoins.has(symbol) ? "stablecoin" : goldTokens.has(symbol) ? "gold" : "crypto", currency: "USD", network: token.network, contract_address: contract, metadata: { chain_id: number(token.chain_id), provider: "Direct RPC" } },
          quantity,
          price_usd: price,
          value_usd: round(value),
          source_key: `oneinch:${hash(address.toLowerCase())}:${number(token.chain_id)}:rpc:${hash(contract)}`,
          metadata: { wallet_address: address.toLowerCase(), chain_id: number(token.chain_id), contract_address: contract, wallet: `${address.slice(0, 6)}…${address.slice(-4)}`, balance_type: "wallet_token", provider: "Direct RPC fallback", pricing_source: token.binance_pair || "configured" },
        });
      }
    }
  }
  return positions;
}

function mergeOneInchWithFallback(oneInchPositions, fallbackPositions) {
  const identity = (position) => `${position.metadata?.wallet_address || ""}|${position.metadata?.chain_id || position.asset.network || ""}|${String(position.metadata?.contract_address || position.asset.contract_address || "native").toLowerCase()}`;
  const covered = new Set(oneInchPositions.map(identity));
  return [...oneInchPositions, ...fallbackPositions.filter((position) => !covered.has(identity(position)))];
}

async function hyperliquidInfo(body) {
  return fetchJson("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadHyperliquid(addresses) {
  const [[spotMeta], mids, reserveRows] = await Promise.all([
    hyperliquidInfo({ type: "spotMetaAndAssetCtxs" }),
    hyperliquidInfo({ type: "allMids" }),
    hyperliquidInfo({ type: "allBorrowLendReserveStates" }),
  ]);
  const tokens = new Map((spotMeta.tokens ?? []).map((token) => [number(token.index), token]));
  const prices = new Map([[0, 1]]);
  for (const market of spotMeta.universe ?? []) {
    const [baseToken, quoteToken] = market.tokens ?? [];
    if (number(quoteToken) !== 0) continue;
    const price = number(mids[market.name]);
    if (price) prices.set(number(baseToken), price);
  }
  const reserves = new Map((reserveRows ?? []).map(([token, state]) => [number(token), state]));
  const positions = [];
  const classify = (symbol) => {
    const normalized = String(symbol).toUpperCase();
    if (["USDC", "USDT", "USDH", "USDE", "DAI"].includes(normalized)) return "stablecoin";
    if (["XAUT", "XAUT0", "PAXG"].includes(normalized)) return "gold";
    return "crypto";
  };
  const tokenPrice = (tokenIndex) => prices.get(number(tokenIndex)) || number(reserves.get(number(tokenIndex))?.oraclePx);
  const tokenAsset = (tokenIndex, suffix = "") => {
    const token = tokens.get(number(tokenIndex));
    const symbol = String(token?.name || `TOKEN-${tokenIndex}`).toUpperCase();
    return {
      symbol: `${symbol}${suffix}`.slice(0, 32),
      name: `${token?.fullName || symbol}${suffix ? ` ${suffix.replace("-", "").toLowerCase()}` : ""}`,
      asset_class: suffix === "-DEBT" ? "liability" : classify(symbol),
      currency: "USD",
      network: "hyperliquid",
      contract_address: token?.evmContract?.address || token?.tokenId || null,
      metadata: { hyperliquid_token_index: number(tokenIndex) },
    };
  };
  for (const address of addresses) {
    const walletLabel = `${address.slice(0, 6)}…${address.slice(-4)}`;
    const [spot, staking, lending, perps, vaults] = await Promise.all([
      hyperliquidInfo({ type: "spotClearinghouseState", user: address }),
      hyperliquidInfo({ type: "delegatorSummary", user: address }),
      hyperliquidInfo({ type: "borrowLendUserState", user: address }),
      hyperliquidInfo({ type: "clearinghouseState", user: address }),
      hyperliquidInfo({ type: "userVaultEquities", user: address }),
    ]);
    const spotAccount = { name: `Hyperliquid · ${address}`, institution: "Hyperliquid", account_type: "wallet", currency: "USD", source: "hyperliquid" };
    for (const balance of spot.balances ?? []) {
      const quantity = number(balance.total);
      const price = tokenPrice(balance.token);
      const value = quantity * price;
      if (!quantity || value < 0.01) continue;
      positions.push({
        account: spotAccount,
        asset: tokenAsset(balance.token),
        quantity,
        price_usd: price,
        value_usd: round(value),
        cost_basis_usd: number(balance.entryNtl) || null,
        source_key: `hyperliquid:${hash(address)}:spot:${number(balance.token)}`,
        metadata: { wallet: walletLabel, balance_type: "spot", held_quantity: number(balance.hold) },
      });
    }
    const stakedHype = number(staking.delegated) + number(staking.undelegated) + number(staking.totalPendingWithdrawal);
    const hypePrice = tokenPrice(150);
    if (stakedHype && hypePrice) positions.push({
      account: { ...spotAccount, name: `Hyperliquid Staking · ${address}` },
      asset: tokenAsset(150),
      quantity: stakedHype,
      price_usd: hypePrice,
      value_usd: round(stakedHype * hypePrice),
      source_key: `hyperliquid:${hash(address)}:staking:hype`,
      metadata: { wallet: walletLabel, balance_type: "staking", delegated: number(staking.delegated), undelegated: number(staking.undelegated), pending_withdrawal: number(staking.totalPendingWithdrawal) },
    });
    for (const [tokenIndex, state] of lending.tokenToState ?? []) {
      const price = tokenPrice(tokenIndex);
      const supplied = number(state.supply?.value);
      const borrowed = number(state.borrow?.value);
      if (supplied && price) positions.push({
        account: { ...spotAccount, name: `Hyperliquid Lending · ${address}` },
        asset: tokenAsset(tokenIndex),
        quantity: supplied,
        price_usd: price,
        value_usd: round(supplied * price),
        cost_basis_usd: number(state.supply?.basis) ? round(number(state.supply.basis) * price) : null,
        source_key: `hyperliquid:${hash(address)}:lending:supply:${number(tokenIndex)}`,
        metadata: { wallet: walletLabel, balance_type: "lending_supply" },
      });
      if (borrowed && price) positions.push({
        account: { ...spotAccount, name: `Hyperliquid Lending · ${address}` },
        asset: tokenAsset(tokenIndex, "-DEBT"),
        quantity: -borrowed,
        price_usd: price,
        value_usd: round(-borrowed * price),
        source_key: `hyperliquid:${hash(address)}:lending:borrow:${number(tokenIndex)}`,
        metadata: { wallet: walletLabel, balance_type: "lending_borrow" },
      });
    }
    const perpEquity = number(perps.marginSummary?.accountValue);
    if (perpEquity >= 0.01) positions.push({
      account: { ...spotAccount, name: `Hyperliquid Perps · ${address}` },
      asset: { symbol: "PERP-EQUITY", name: "Perpetuals account equity", asset_class: "alternative", currency: "USD", network: "hyperliquid", contract_address: null, metadata: {} },
      quantity: perpEquity,
      price_usd: 1,
      value_usd: round(perpEquity),
      source_key: `hyperliquid:${hash(address)}:perps:equity`,
      metadata: { wallet: walletLabel, balance_type: "perpetuals_equity", open_positions: perps.assetPositions?.length ?? 0 },
    });
    for (const vault of vaults ?? []) {
      const equity = number(vault.equity);
      if (equity < 0.01) continue;
      positions.push({
        account: { ...spotAccount, name: `Hyperliquid Vaults · ${address}` },
        asset: { symbol: "VAULT-EQUITY", name: "Hyperliquid vault equity", asset_class: "alternative", currency: "USD", network: "hyperliquid", contract_address: vault.vaultAddress, metadata: {} },
        quantity: equity,
        price_usd: 1,
        value_usd: round(equity),
        source_key: `hyperliquid:${hash(address)}:vault:${hash(vault.vaultAddress)}`,
        metadata: { wallet: walletLabel, balance_type: "vault", vault_address: vault.vaultAddress },
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
  const credentials = keyFile ? parseKeyFile(await fs.readFile(keyFile, "utf8")) : { ...serverCredentials, ...process.env };
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
    const preciousMetal = ["XAUT", "XAUT0", "PAXG"].includes(asset);
    return {
      account: { name: "Binance", institution: "Binance", account_type: "exchange", currency: "USD", source: "binance" },
      asset: { symbol: asset, name: asset, asset_class: stable ? "stablecoin" : preciousMetal ? "gold" : "crypto", currency: "USD", network: "binance", contract_address: null, metadata: {} },
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

async function loadEtherfiSpend(csvPath) {
  const rows = parseCsv(await fs.readFile(csvPath, "utf8"));
  const headers = rows.shift().map((value) => value.trim().toLowerCase());
  const ix = Object.fromEntries(headers.map((name, index) => [name, index]));
  const value = (row, name) => String(row[ix[name]] ?? "").trim();
  const typeFor = (type) => type.includes("cashback") ? "cashback" : ({
    card_spend: "purchase",
    card_refund: "refund",
    topup: "topup",
    cash_withdrawal: "withdrawal",
  })[type] ?? type.replaceAll("_", " ");
  return rows.map((row) => {
    const sourceType = value(row, "type").toLowerCase();
    const occurredAt = new Date(value(row, "timestamp"));
    const amountUsd = number(value(row, "amount"));
    const card = value(row, "card");
    const merchant = value(row, "description").replace(/\s+/g, " ").trim();
    const originalCurrency = value(row, "original currency").toUpperCase();
    const transactionType = typeFor(sourceType);
    const identity = [occurredAt.toISOString(), sourceType, merchant, amountUsd, value(row, "currency"), card].join("|");
    return {
      source: "ether.fi",
      external_ref: `etherfi:${hash(identity)}`,
      occurred_at: occurredAt.toISOString(),
      merchant: merchant || null,
      description: sourceType.replaceAll("_", " "),
      status: value(row, "status").toLowerCase() || (transactionType === "cashback" ? "cleared" : null),
      transaction_type: transactionType,
      original_amount: value(row, "original amount") ? number(value(row, "original amount")) : null,
      original_currency: /^[A-Z]{3}$/.test(originalCurrency) ? originalCurrency : null,
      amount_usd: round(amountUsd),
      category: value(row, "category") || null,
      card_last_four: /^\d{4}$/.test(card) ? card : null,
      metadata: {
        spending_mode: value(row, "spending mode") || null,
        cashback_earned: value(row, "cashback earned") ? number(value(row, "cashback earned")) : null,
        cashback_currency: value(row, "cashback currency") || null,
        original_unit: originalCurrency && !/^[A-Z]{3}$/.test(originalCurrency) ? originalCurrency : null,
        transaction_hash: value(row, "transaction hash") || value(row, "tx hash") || value(row, "tx_hash") || null,
        explorer_url: value(row, "explorer url") || value(row, "transaction url") || null,
        import_file: path.basename(csvPath),
      },
    };
  }).filter((row) => Number.isFinite(new Date(row.occurred_at).getTime()) && row.external_ref);
}

async function parseKastStatement(pdfPath) {
  const pages = [];
  await pdfParse(await fs.readFile(pdfPath), {
    pagerender: (page) => page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false }).then((content) => {
      pages.push(content.items.map((item) => ({ text: String(item.str).trim(), x: item.transform[4], y: item.transform[5] })).filter((item) => item.text));
      return "";
    }),
  });
  const transactions = [];
  const amountAt = (items, minX, maxX) => {
    const item = items.find((candidate) => candidate.x >= minX && candidate.x < maxX && /^-?[\d,]+\.\d{2}$/.test(candidate.text));
    return item ? number(item.text) : null;
  };
  for (const items of pages) {
    const dates = items.filter((item) => item.x < 90 && /^\d{2} [A-Z][a-z]{2} \d{4}$/.test(item.text)).sort((a, b) => b.y - a.y);
    const rewardItem = items.find((item) => item.x >= 90 && item.x < 350 && /^Cash Reward/.test(item.text));
    if (rewardItem && dates.length) {
      const rewardLine = items.filter((item) => Math.abs(item.y - rewardItem.y) < 1.5);
      const reward = amountAt(rewardLine, 350, 425);
      const balanceAfter = amountAt(rewardLine, 505, 590);
      if (reward != null && reward > 0) {
        const [, month, year] = dates[0].text.match(/^\d{2} ([A-Z][a-z]{2}) (\d{4})$/) || [];
        const occurredAt = new Date(`01 ${month} ${year} 12:00:00 GMT+0530`).toISOString();
        transactions.push({
          source: "kast",
          external_ref: `kast:cash-reward:${occurredAt.slice(0, 7)}:${hash(path.basename(pdfPath))}`,
          occurred_at: occurredAt,
          merchant: "Cash Reward",
          description: "cashback",
          status: "cleared",
          transaction_type: "cashback",
          original_amount: reward,
          original_currency: "USD",
          amount_usd: round(reward),
          category: "Cashback",
          card_last_four: null,
          metadata: { import_file: path.basename(pdfPath), balance_after_usd: balanceAfter, statement_level_reward: true },
        });
      }
    }
    for (let index = 0; index < dates.length; index += 1) {
      const date = dates[index];
      const nextY = dates[index + 1]?.y ?? date.y - 100;
      const sameLine = items.filter((item) => Math.abs(item.y - date.y) < 1.5);
      const detailItems = items.filter((item) => item.y <= date.y + 1.5 && item.y > nextY + 1.5 && item.x >= 90 && item.x < 350).sort((a, b) => b.y - a.y || a.x - b.x);
      const description = sameLine.filter((item) => item.x >= 90 && item.x < 350).sort((a, b) => a.x - b.x).map((item) => item.text).join("").replace(/\s+/g, " ").trim();
      const details = detailItems.map((item) => item.text).join(" ");
      const transactionId = details.match(/Transaction ID\s*:\s*([a-zA-Z0-9-]+)/)?.[1];
      const cardLastFour = details.match(/\*(\d{4})/)?.[1] ?? null;
      const moneyIn = amountAt(sameLine, 350, 425);
      const moneyOut = amountAt(sameLine, 425, 505);
      const balanceAfter = amountAt(sameLine, 505, 590);
      if (moneyIn == null && moneyOut == null) continue;
      const isRefund = moneyIn != null && Boolean(cardLastFour);
      const isPurchase = moneyOut != null && Boolean(cardLastFour);
      const transactionType = isRefund ? "refund" : isPurchase ? "purchase" : moneyIn != null ? "transfer_in" : "transfer";
      const amountUsd = isRefund ? -moneyIn : moneyOut ?? moneyIn ?? 0;
      const occurredAt = new Date(`${date.text} 12:00:00 GMT+0530`).toISOString();
      transactions.push({
        source: "kast",
        external_ref: `kast:${transactionId || hash([occurredAt, description, moneyIn, moneyOut, balanceAfter].join("|"))}:${moneyIn != null ? "in" : "out"}`,
        occurred_at: occurredAt,
        merchant: description || null,
        description: transactionType.replaceAll("_", " "),
        status: "cleared",
        transaction_type: transactionType,
        original_amount: Math.abs(amountUsd),
        original_currency: "USD",
        amount_usd: round(amountUsd),
        category: null,
        card_last_four: cardLastFour,
        metadata: { import_file: path.basename(pdfPath), transaction_id: transactionId || null, balance_after_usd: balanceAfter },
      });
    }
  }
  return transactions;
}

async function loadKastSpend(pdfPaths) {
  const transactions = [];
  for (const pdfPath of pdfPaths) transactions.push(...await parseKastStatement(pdfPath));
  return transactions;
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
      const match = String(row[7] ?? "").match(/(?:OPEN|CLOSE) (?:BUY|SELL) (?:[A-Z][A-Z0-9.-]* )?([\d.]+)(?:\/[\d.]+)? @ ([\d.]+)/i);
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
        metadata: { category: row[3] || null, product: row[8] || null, raw_description: row[7] || null },
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

function summarizeSpend(transactions) {
  const byType = {};
  const months = new Set();
  for (const transaction of transactions) {
    byType[transaction.transaction_type] = (byType[transaction.transaction_type] ?? 0) + 1;
    months.add(transaction.occurred_at.slice(0, 7));
  }
  return { records: transactions.length, by_type: byType, months: [...months].sort() };
}

const portfolioSources = ["rabby", "debank", "oneinch", "hyperliquid", "binance", "wio", "wio-stocks", "xtb"];
const needsPortfolioSync = !only || portfolioSources.some((source) => only.has(source));
const fx = needsPortfolioSync ? await loadFx() : {};
const sourcePositions = {};
const sourceErrors = {};
let xtbTransactions = [];
let etherfiSpendTransactions = [];
let kastSpendTransactions = [];
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
if (shouldRun("debank")) {
  const result = await captureSource("debank", () => loadDeBank(required("PORTFOLIO_EVM_ADDRESSES").split(",").map((value) => value.trim()).filter(Boolean), process.env.DEBANK_ACCESS_KEY?.trim() || serverCredentials.DEBANK_ACCESS_KEY?.trim()));
  if (result) sourcePositions.debank = result;
}
if (shouldRun("oneinch")) {
  const result = await captureSource("oneinch", async () => {
    const addresses = required("PORTFOLIO_EVM_ADDRESSES").split(",").map((value) => value.trim()).filter(Boolean);
    const oneInchPositions = await loadOneInch(addresses, process.env.ONEINCH_API_KEY?.trim() || serverCredentials.ONEINCH_API_KEY?.trim());
    const defaultWatchFile = process.env.PORTFOLIO_SERVER_KEY_FILE?.trim() ? path.join(path.dirname(process.env.PORTFOLIO_SERVER_KEY_FILE.trim()), "portfolio-watch-tokens.json") : null;
    const watchConfig = process.env.PORTFOLIO_WATCH_TOKENS_JSON?.trim()
      || serverCredentials.PORTFOLIO_WATCH_TOKENS_JSON?.trim()
      || (defaultWatchFile ? await fs.readFile(defaultWatchFile, "utf8").catch(() => "") : "");
    const fallbackPositions = await loadWatchedTokens(addresses, watchConfig);
    return mergeOneInchWithFallback(oneInchPositions, fallbackPositions);
  });
  if (result) sourcePositions.oneinch = result;
}
if (shouldRun("hyperliquid")) {
  const addressList = process.env.PORTFOLIO_HYPERLIQUID_ADDRESSES?.trim() || serverCredentials.PORTFOLIO_HYPERLIQUID_ADDRESSES?.trim() || required("PORTFOLIO_EVM_ADDRESSES");
  const result = await captureSource("hyperliquid", () => loadHyperliquid(addressList.split(",").map((value) => value.trim()).filter(Boolean)));
  if (result) sourcePositions.hyperliquid = result;
}
if (shouldRun("binance")) {
  const result = await captureSource("binance", () => loadBinance(process.env.BINANCE_KEY_FILE?.trim() || serverCredentials.BINANCE_KEY_FILE?.trim()));
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
if (shouldRun("etherfi") && process.env.ETHERFI_CSV_PATH?.trim()) {
  const result = await captureSource("etherfi", () => loadEtherfiSpend(process.env.ETHERFI_CSV_PATH.trim()));
  if (result) etherfiSpendTransactions = result;
}
if (shouldRun("kast") && (process.env.KAST_PDF_PATHS?.trim() || process.env.KAST_PDF_DIR?.trim())) {
  const kastPaths = process.env.KAST_PDF_PATHS?.trim()
    ? process.env.KAST_PDF_PATHS.split(path.delimiter).filter(Boolean)
    : (await fs.readdir(process.env.KAST_PDF_DIR.trim())).filter((name) => name.toLowerCase().endsWith(".pdf")).sort().map((name) => path.join(process.env.KAST_PDF_DIR.trim(), name));
  const result = await captureSource("kast", () => loadKastSpend(kastPaths));
  if (result) kastSpendTransactions = result;
}

if (dryRun) {
  console.log(JSON.stringify({ as_of: now, fx, sources: summarize(sourcePositions), source_errors: sourceErrors, xtb_history_records: xtbTransactions.length, etherfi_spend_records: etherfiSpendTransactions.length, kast_spend: summarizeSpend(kastSpendTransactions), ...(debug ? { current_asset_positions: Object.fromEntries(Object.entries(sourcePositions).map(([source, positions]) => [source, positions.filter((position) => Math.abs(position.value_usd) >= 100).map((position) => ({ account: position.account.name, symbol: position.asset.symbol, network: position.asset.network, quantity: position.quantity, price_usd: position.price_usd, value_usd: position.value_usd }))])), xtb_missing_quantity_samples: xtbTransactions.filter((transaction) => transaction.quantity == null && /stock (sell|purchase)/i.test(transaction.event_type)).slice(0, 40).map((transaction) => ({ event_type: transaction.event_type, amount_usd: transaction.amount_usd, raw_description: transaction.metadata.raw_description, asset: transaction.asset?.symbol })) } : {}) }, null, 2));
  process.exit(0);
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const supabaseKey = required("SUPABASE_SECRET_KEY");
const ownerEmail = (process.env.PORTFOLIO_OWNER_EMAIL?.trim() || serverCredentials.PORTFOLIO_OWNER_EMAIL?.trim())?.toLowerCase();
const configuredOwnerId = process.env.PORTFOLIO_OWNER_ID?.trim() || serverCredentials.PORTFOLIO_OWNER_ID?.trim();
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
  const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, symbol: `eq.${asset.symbol}`, select: "id,network,contract_address,asset_class" });
  const candidates = await supabase(`/rest/v1/assets?${query}`);
  const existing = candidates.find((item) => (item.network ?? null) === (asset.network ?? null) && (item.contract_address ?? null) === (asset.contract_address ?? null));
  const id = existing?.id ?? (await supabase("/rest/v1/assets", { method: "POST", body: { owner_id: ownerId, ...asset }, prefer: "return=representation" }))[0].id;
  if (existing && existing.asset_class !== asset.asset_class) {
    await supabase(`/rest/v1/assets?id=eq.${existing.id}`, { method: "PATCH", body: { asset_class: asset.asset_class }, prefer: "return=minimal" });
  }
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

if (sourcePositions.debank) {
  const staleRabbyQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, source_key: "like.rabby:%", select: "id" });
  for (const stale of await supabase(`/rest/v1/positions?${staleRabbyQuery}`)) {
    await supabase(`/rest/v1/positions?id=eq.${stale.id}`, { method: "DELETE" });
  }
}

if (sourcePositions.oneinch) {
  const staleRabbyQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, source_key: "like.rabby:%", select: "id" });
  for (const stale of await supabase(`/rest/v1/positions?${staleRabbyQuery}`)) {
    await supabase(`/rest/v1/positions?id=eq.${stale.id}`, { method: "DELETE" });
  }
}

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

if (etherfiSpendTransactions.length) {
  const rows = etherfiSpendTransactions.map((transaction) => ({ owner_id: ownerId, ...transaction }));
  for (let index = 0; index < rows.length; index += 100) {
    await supabase("/rest/v1/spend_transactions?on_conflict=owner_id,source,external_ref", { method: "POST", body: rows.slice(index, index + 100), prefer: "resolution=merge-duplicates,return=minimal" });
  }
}

if (kastSpendTransactions.length) {
  const rows = kastSpendTransactions.map((transaction) => ({ owner_id: ownerId, ...transaction }));
  for (let index = 0; index < rows.length; index += 100) {
    await supabase("/rest/v1/spend_transactions?on_conflict=owner_id,source,external_ref", { method: "POST", body: rows.slice(index, index + 100), prefer: "resolution=merge-duplicates,return=minimal" });
  }
}

if (!needsPortfolioSync) {
  console.log(JSON.stringify({ as_of: now, source_errors: sourceErrors, etherfi_spend_records: etherfiSpendTransactions.length, kast_spend_records: kastSpendTransactions.length }, null, 2));
  process.exit(0);
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
console.log(JSON.stringify({ as_of: now, fx, sources: summarize(sourcePositions), source_errors: sourceErrors, xtb_history_records: xtbTransactions.length, etherfi_spend_records: etherfiSpendTransactions.length, kast_spend_records: kastSpendTransactions.length, snapshot_positions: positionSnapshots.length, portfolio: totals }, null, 2));
