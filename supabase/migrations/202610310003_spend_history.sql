create table public.spend_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  external_ref text not null,
  occurred_at timestamptz not null,
  posted_at timestamptz,
  merchant text,
  description text,
  status text,
  transaction_type text not null default 'purchase',
  original_amount numeric(24, 8),
  original_currency text check (original_currency is null or length(original_currency) = 3),
  amount_usd numeric(24, 2) not null,
  category text,
  card_last_four text check (card_last_four is null or card_last_four ~ '^[0-9]{4}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source, external_ref)
);

create index spend_transactions_owner_time_idx
  on public.spend_transactions (owner_id, occurred_at desc);

create trigger spend_transactions_set_updated_at before update on public.spend_transactions
for each row execute function public.set_updated_at();

alter table public.spend_transactions enable row level security;
revoke all on public.spend_transactions from anon;
grant select on public.spend_transactions to authenticated;

create policy spend_transactions_owner_read on public.spend_transactions
for select to authenticated using (owner_id = auth.uid());

comment on table public.spend_transactions is 'Normalized Ether.fi, KAST, Ethena Pay, and other spend history. Never store full card numbers or authentication secrets.';
