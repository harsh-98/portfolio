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

The local sync adapter reads live FX (Frankfurter), Rabby wallet balances, Binance, Wio CSV exports, and XTB XLSX/ZIP exports. It writes current positions, one position-level snapshot per day, XTB transaction history, and an audit row for each source. It never writes credentials to the database.

Run a read-only reconciliation first:

```bash
npm run sync:portfolio -- --dry-run
```

Then provide the server-side variables in `.env.example` through a protected environment and run without `--dry-run`. Source-specific refreshes are supported with `--only=rabby,binance,wio,xtb`.

The protected GitHub Action is ready for Rabby and Binance snapshots and can be run manually. A daily 08:00 Asia/Kolkata schedule can be enabled after its six values are explicitly placed in encrypted GitHub Actions secrets. Wio and XTB are imported locally because their exports are intentionally not uploaded to GitHub.

Rabby cost basis is an estimate only when recent on-chain history contains priced external receipts. Internal transfers between the configured wallets are excluded; positions without enough evidence remain explicitly unavailable.

## Card-spend history

Supabase includes an owner-scoped `spend_transactions` ledger for Ether.fi Cash, KAST, Ethena Pay, and future cards. It stores merchant, date, status, original amount/currency, normalized USD amount, category, and at most the last four card digits—never a full card number or login secret.

Ether.fi officially supports CSV and Excel transaction-history exports. Put those exports in the private banking folder for normalization. KAST and Ethena Pay do not currently publish a consumer card-history API suitable for this dashboard; use an in-app export or statement when available. Provider-specific import mappings are added only after inspecting a sample export, so columns and refund/pending semantics are not guessed.
