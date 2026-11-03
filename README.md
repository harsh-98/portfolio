# Northstar Portfolio

A private, multi-asset portfolio dashboard for GitHub Pages, backed by Supabase Auth and owner-scoped PostgreSQL records.

## Security model

- GitHub Pages contains application code only. It contains no portfolio records.
- The browser uses a Supabase publishable key and an authenticated user session.
- PostgreSQL Row Level Security allows approved authenticated users to read the shared portfolio; writes remain scoped to the UUID that owns each row.
- The Supabase secret key, exchange API secrets, bank data and private wallet credentials must never enter this repository.
- The dashboard never needs seed data committed to Git.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Install and run:

```bash
npm install
npm run dev
```

## Supabase

Link the project and deploy migrations using the official CLI:

```bash
npx supabase login
npx supabase link --project-ref xbnqpyrqgtvfynuqwcmn
npx supabase db push
```

In Supabase Auth URL Configuration, set:

- Site URL: `https://harsh-98.github.io/portfolio/`
- Additional redirect URL: `http://localhost:5173/portfolio/`

Create approved users through the dashboard's email magic-link form, then disable open sign-ups. All authenticated users can read the shared portfolio; authentication is still required and anonymous reads remain denied.

## GitHub Pages

Set these repository Actions variables:

- `VITE_SUPABASE_URL=https://xbnqpyrqgtvfynuqwcmn.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...`

Set Pages source to **GitHub Actions**. Pushing to `main` builds and deploys the static dashboard.

## Data imports and snapshots

The local sync adapter reads live FX (Frankfurter), Rabby wallet balances, Binance, Wio CSV exports, and XTB XLSX/ZIP exports. It writes current positions, one position-level snapshot per day, XTB transaction history, and an audit row for each source. It never writes credentials to the database. Current wallet refreshes also supplement Plasma when the main indexer omits it: Rabby is preferred, with a paced public-RPC fallback covering the verified Plasma token/receipt set. `--plasma-rpc` selects the direct fallback when Rabby is rate-limited. Vault shares use on-chain redemption values; the fallback's coverage is recorded in position metadata. Current 1inch refreshes verify known provider omissions using the public-contract watches in `scripts/watched-tokens.json`, plus optional private watch configuration. `--reconcile-rabby` additionally discovers direct wallet tokens across funded networks using paced requests; this audit is explicit because Rabby limits broad requests. Verified missing contracts can be added to the RPC watches for routine refreshes. Missing tokens are merged by wallet, numeric chain ID and contract, so the same symbol on Ethereum and Arbitrum stays separate. A failed reconciliation preserves existing wallet positions rather than publishing an incomplete replacement.

Run a read-only reconciliation first:

```bash
npm run sync:portfolio -- --dry-run
```

Then provide the server-side variables in `.env.example` through a protected environment and run without `--dry-run`. Source-specific refreshes are supported with `--only=rabby,binance,wio,xtb`.

The browser loads at most 200 chart points for the selected wallet/platform and range. Imports publish a private precomputed summary through `scripts/build-history-charts.py`, using a reserved `_HISTORY_CHART_CACHE` asset's metadata without creating any positions or financial values. Existing authenticated read policies protect this cache. JSON projections return only the manifest or selected dataset; raw snapshots remain the source of truth and are never downloaded by the chart. First/last points and bucket extrema are retained when sampling long ranges. Sync/backfill commands rebuild the cache automatically; to rebuild manually, supply `PORTFOLIO_SERVER_KEY_FILE` (or protected server environment variables) and run `python3 scripts/build-history-charts.py`.

Historical crypto backfills are checkpointed by wallet, chain, and week. Use `--addresses=0x...[,0x...]` and `--chains=eth-mainnet[,base-mainnet]` with `scripts/backfill-crypto-history.mjs` to prioritize configured wallets or supported chains; the address filter cannot add wallets absent from `PORTFOLIO_EVM_ADDRESSES`.

The complete wallet-history backfill uses 1inch historical token **and DeFi** snapshots across its supported networks, including Arbitrum. Run `npm run backfill:wallets -- --from=YYYY-MM-DD --to=YYYY-MM-DD --dry-run` with `PORTFOLIO_SERVER_KEY_FILE` pointing to the protected server configuration, then omit `--dry-run` to populate. Dates use a common Tuesday UTC cadence across every wallet/network. This collector defaults to $0.01, independently of the dashboard's $100 asset-display cutoff. Success checkpoints are resumable; `--force` refreshes them. Explicit zero-coverage rows stop old balances persisting when a network becomes empty. Existing legacy snapshots remain available, while the chart selects complete observations instead of adding duplicate providers/dates. Provider coverage still limits which protocols can be reconstructed; unavailable values are not estimated from current holdings.

Rabby transaction history can reveal holdings on networks absent from the indexed provider. `scripts/backfill-plasma-history.py` supplements Plasma from a private Rabby `history_list`/`token_dict` export. Set `PORTFOLIO_SERVER_KEY_FILE` and pass `--rabby-history=/private/export.json --wallet-prefix=0x... --report=/private/report.json`. The default is read-only; `--monthly` compares the last weekly snapshot in each month, and `--write` publishes the weekly correction. It verifies the wallet and token definitions, reads historical ERC-20 balances, and converts Fluid/Gearbox vault shares at the same historical block. USD values use historical Binance opens and a global USDT/USD proxy for bridged USDT0, with historical DefiLlama prices for FLUID; these are reconstructed marks, not Rabby-reported monthly net-worth totals. Current balances and other wallets are untouched.

Linea native ETH history uses the public Linea archive RPC for historical balances and Binance public ETH/USDT daily closes for same-date valuation. Run `npm run backfill:linea -- --from=YYYY-MM-DD --to=YYYY-MM-DD`; it shares the same resumable checkpoint table and USD 100 default threshold.

The protected GitHub Action is ready for Rabby and Binance snapshots and can be run manually. A daily 08:00 Asia/Kolkata schedule can be enabled after its six values are explicitly placed in encrypted GitHub Actions secrets. Wio and XTB are imported locally because their exports are intentionally not uploaded to GitHub.

Rabby cost basis is an estimate only when recent on-chain history contains priced external receipts. Internal transfers between the configured wallets are excluded; positions without enough evidence remain explicitly unavailable.

## Card-spend history

Supabase includes an owner-scoped `spend_transactions` ledger for Ether.fi Cash, KAST, Ethena Pay, and future cards. It stores merchant, date, status, original amount/currency, normalized USD amount, category, and at most the last four card digits—never a full card number or login secret.

Ether.fi officially supports CSV and Excel transaction-history exports. Put those exports in the private banking folder for normalization. KAST and Ethena Pay do not currently publish a consumer card-history API suitable for this dashboard; use an in-app export or statement when available. Provider-specific import mappings are added only after inspecting a sample export, so columns and refund/pending semantics are not guessed.

On the crypto history chart, select a point or a snapshot date to inspect that week’s saved composition. The browser fetches only the selected date’s private summarized assets and networks; chart ranges remain limited to 200 points and never download the raw snapshot table. Select Latest to return to the latest composition.

The site installs as **Northstar** with a standalone manifest and Apple touch icon. Add the canonical `/portfolio/` URL to the home screen. A build-versioned service worker caches only the public app shell and static assets; authentication and financial API responses are never cached. Offline startup can show the shell, but portfolio data still requires a connection. Browser and installed-app storage can differ on iOS. Use the optional Password method below to sign in directly in the installed app; its session persists in that app’s own Supabase storage. No session tokens are transferred through install URLs or the manifest.


Home-screen users can also choose **Password** on the login page. Each approved user first opens their already logged-in browser and chooses **Profile → Set/change password**, then sets their own password (at least 12 characters). This calls Supabase `updateUser` in that user's authenticated session; sign-in uses `signInWithPassword`. It requires no custom SMTP or email-template change, preserves existing email-link login, and does not enable public sign-ups. Passwords are never saved in browser storage, caches or logs by this app. Any password recovery uses the existing provider flow; the app does not send custom email or reset someone else's password.
