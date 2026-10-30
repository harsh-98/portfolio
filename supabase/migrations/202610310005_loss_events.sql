create table public.loss_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,
  event_at timestamptz,
  date_precision text not null default 'unknown' check (date_precision in ('exact', 'month', 'valuation_date', 'unknown')),
  title text not null,
  category text not null,
  status text not null check (status in ('realized', 'unrealized', 'mixed', 'pending')),
  loss_low_usd numeric(24, 2),
  loss_high_usd numeric(24, 2),
  details text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, event_key),
  check (loss_low_usd is null or loss_low_usd >= 0),
  check (loss_high_usd is null or loss_high_usd >= coalesce(loss_low_usd, 0))
);

create index loss_events_owner_date_idx on public.loss_events (owner_id, event_at desc nulls last);

create trigger loss_events_set_updated_at before update on public.loss_events
for each row execute function public.set_updated_at();

alter table public.loss_events enable row level security;
revoke all on public.loss_events from anon;
grant select on public.loss_events to authenticated;

create policy loss_events_authenticated_read on public.loss_events
for select to authenticated using (true);

comment on table public.loss_events is 'Private reconciled history of realized, unrealized, estimated, and pending portfolio losses.';
