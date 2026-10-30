create table public.position_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  captured_at timestamptz not null default now(),
  source_key text not null,
  account_id uuid references public.accounts(id) on delete set null,
  asset_id uuid references public.assets(id) on delete set null,
  quantity numeric(38, 18) not null default 0,
  price_usd numeric(24, 8) not null default 0,
  value_usd numeric(24, 2) not null default 0,
  cost_basis_usd numeric(24, 2),
  metadata jsonb not null default '{}'::jsonb,
  unique (owner_id, snapshot_date, source_key)
);

create index position_snapshots_owner_date_idx
  on public.position_snapshots (owner_id, snapshot_date desc);

create table public.brokerage_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  external_ref text not null,
  account_id uuid references public.accounts(id) on delete set null,
  asset_id uuid references public.assets(id) on delete set null,
  event_time timestamptz not null,
  event_type text not null,
  quantity numeric(38, 18),
  price_usd numeric(24, 8),
  amount_usd numeric(24, 2),
  realized_pnl_usd numeric(24, 2),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, source, external_ref)
);

create index brokerage_transactions_owner_time_idx
  on public.brokerage_transactions (owner_id, event_time desc);

alter table public.position_snapshots enable row level security;
alter table public.brokerage_transactions enable row level security;

revoke all on public.position_snapshots, public.brokerage_transactions from anon;
grant select on public.position_snapshots, public.brokerage_transactions to authenticated;

create policy position_snapshots_owner_read on public.position_snapshots
for select to authenticated using (owner_id = auth.uid());

create policy brokerage_transactions_owner_read on public.brokerage_transactions
for select to authenticated using (owner_id = auth.uid());

comment on table public.position_snapshots is 'Immutable-by-day position history used to compare wallet, chain, and asset changes.';
comment on table public.brokerage_transactions is 'Normalized brokerage export history; never stores brokerage credentials or account numbers.';
