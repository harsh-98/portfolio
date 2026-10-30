create table public.crypto_backfill_checkpoints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  wallet_hash text not null,
  chain_name text not null,
  snapshot_date date not null,
  status text not null check (status in ('success', 'failed')),
  records_written integer not null default 0,
  message text,
  completed_at timestamptz not null default now(),
  unique (owner_id, wallet_hash, chain_name, snapshot_date)
);

create index crypto_backfill_checkpoints_owner_date_idx
  on public.crypto_backfill_checkpoints (owner_id, snapshot_date desc);

alter table public.crypto_backfill_checkpoints enable row level security;
revoke all on public.crypto_backfill_checkpoints from anon;
grant select on public.crypto_backfill_checkpoints to authenticated;

create policy crypto_backfill_checkpoints_authenticated_read on public.crypto_backfill_checkpoints
for select to authenticated using (true);

comment on table public.crypto_backfill_checkpoints is 'Resumable status for reconstructed weekly wallet history; wallet_hash is non-reversible and no API credentials are stored.';
