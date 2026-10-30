create extension if not exists pgcrypto;
create extension if not exists pg_graphql with schema graphql;

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  institution text not null default '',
  account_type text not null default 'manual',
  currency text not null default 'USD' check (length(currency) = 3),
  source text not null default 'manual',
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name, institution)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null check (length(symbol) between 1 and 32),
  name text not null check (length(name) between 1 and 160),
  asset_class text not null check (asset_class in ('cash', 'stablecoin', 'equity', 'crypto', 'fixed_income', 'gold', 'nft', 'alternative', 'liability')),
  currency text not null default 'USD' check (length(currency) = 3),
  network text,
  contract_address text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index assets_owner_identity_idx
  on public.assets (owner_id, symbol, coalesce(network, ''), coalesce(contract_address, ''));

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  quantity numeric(38, 18) not null default 0,
  price_usd numeric(24, 8) not null default 0 check (price_usd >= 0),
  value_usd numeric(24, 2) not null default 0,
  cost_basis_usd numeric(24, 2),
  source_key text not null,
  as_of timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source_key)
);

create index positions_owner_value_idx on public.positions (owner_id, value_usd desc);
create index positions_account_idx on public.positions (account_id);
create index positions_asset_idx on public.positions (asset_id);

create table public.portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  total_value_usd numeric(24, 2) not null default 0,
  cash_usd numeric(24, 2) not null default 0,
  equities_usd numeric(24, 2) not null default 0,
  crypto_usd numeric(24, 2) not null default 0,
  alternatives_usd numeric(24, 2) not null default 0,
  liabilities_usd numeric(24, 2) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, snapshot_date)
);

create index portfolio_snapshots_owner_date_idx on public.portfolio_snapshots (owner_id, snapshot_date desc);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  records_seen integer not null default 0,
  records_written integer not null default 0,
  message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index sync_runs_owner_started_idx on public.sync_runs (owner_id, started_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger accounts_set_updated_at before update on public.accounts
for each row execute function public.set_updated_at();
create trigger assets_set_updated_at before update on public.assets
for each row execute function public.set_updated_at();
create trigger positions_set_updated_at before update on public.positions
for each row execute function public.set_updated_at();

alter table public.accounts enable row level security;
alter table public.assets enable row level security;
alter table public.positions enable row level security;
alter table public.portfolio_snapshots enable row level security;
alter table public.sync_runs enable row level security;

revoke all on public.accounts, public.assets, public.positions, public.portfolio_snapshots, public.sync_runs from anon;
grant select, insert, update, delete on public.accounts, public.assets, public.positions, public.portfolio_snapshots to authenticated;
grant select on public.sync_runs to authenticated;

create policy accounts_owner_all on public.accounts
for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy assets_owner_all on public.assets
for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy positions_owner_all on public.positions
for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy snapshots_owner_all on public.portfolio_snapshots
for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy sync_runs_owner_read on public.sync_runs
for select to authenticated using (owner_id = auth.uid());

create or replace function public.create_daily_snapshot()
returns public.portfolio_snapshots
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result public.portfolio_snapshots;
begin
  insert into public.portfolio_snapshots (
    owner_id,
    snapshot_date,
    total_value_usd,
    cash_usd,
    equities_usd,
    crypto_usd,
    alternatives_usd,
    liabilities_usd
  )
  select
    auth.uid(),
    current_date,
    coalesce(sum(p.value_usd), 0),
    coalesce(sum(p.value_usd) filter (where a.asset_class in ('cash', 'stablecoin')), 0),
    coalesce(sum(p.value_usd) filter (where a.asset_class = 'equity'), 0),
    coalesce(sum(p.value_usd) filter (where a.asset_class in ('crypto', 'nft')), 0),
    coalesce(sum(p.value_usd) filter (where a.asset_class in ('fixed_income', 'gold', 'alternative')), 0),
    coalesce(sum(p.value_usd) filter (where a.asset_class = 'liability'), 0)
  from public.positions p
  join public.assets a on a.id = p.asset_id
  where p.owner_id = auth.uid()
  on conflict (owner_id, snapshot_date) do update set
    total_value_usd = excluded.total_value_usd,
    cash_usd = excluded.cash_usd,
    equities_usd = excluded.equities_usd,
    crypto_usd = excluded.crypto_usd,
    alternatives_usd = excluded.alternatives_usd,
    liabilities_usd = excluded.liabilities_usd
  returning * into result;
  return result;
end;
$$;

grant execute on function public.create_daily_snapshot() to authenticated;

comment on table public.accounts is 'Owner-scoped financial accounts. Never store login credentials here.';
comment on table public.positions is 'Current positions only; immutable daily totals are retained in portfolio_snapshots.';
comment on column public.accounts.external_ref is 'Optional non-secret provider identifier. Do not store account numbers.';
