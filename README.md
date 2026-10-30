# Northstar Portfolio

A private, multi-asset portfolio dashboard for GitHub Pages, backed by Supabase Auth and owner-scoped PostgreSQL records.

## Security model

- GitHub Pages contains application code only. It contains no portfolio records.
- The browser uses a Supabase publishable key and an authenticated user session.
- PostgreSQL Row Level Security restricts every row to `auth.uid()`.
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

Create the first user through the dashboard's email magic-link form, then disable open sign-ups if this will remain a single-user application.

## GitHub Pages

Set these repository Actions variables:

- `VITE_SUPABASE_URL=https://xbnqpyrqgtvfynuqwcmn.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...`

Set Pages source to **GitHub Actions**. Pushing to `main` builds and deploys the static dashboard.

## Data imports

Provider sync jobs will run locally or in a protected backend process. Only normalized holdings and snapshots are written to Supabase. Credentials remain in macOS Keychain or the provider's protected secrets store.
