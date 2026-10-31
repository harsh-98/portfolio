create or replace view public.wallet_weekly_snapshot_json
with (security_invoker = true)
as
with wallet_positions as (
  select
    ps.owner_id,
    ps.snapshot_date - ((extract(dow from ps.snapshot_date)::integer + 5) % 7) as week_start,
    ps.snapshot_date as observed_date,
    ps.captured_at,
    ps.source_key,
    substring(ac.name from '(0x[0-9A-Fa-f]{40})') as wallet_address,
    coalesce(nullif(a.network, ''), 'Unknown') as network,
    a.id as asset_id,
    a.symbol,
    a.name as asset_name,
    a.asset_class,
    a.contract_address,
    ac.name as account_name,
    ps.quantity,
    ps.price_usd,
    ps.value_usd,
    ps.metadata,
    row_number() over (
      partition by
        ps.owner_id,
        ps.snapshot_date - ((extract(dow from ps.snapshot_date)::integer + 5) % 7),
        substring(ac.name from '(0x[0-9A-Fa-f]{40})'),
        ps.source_key
      order by ps.snapshot_date desc, ps.captured_at desc
    ) as source_rank
  from public.position_snapshots ps
  join public.accounts ac on ac.id = ps.account_id
  join public.assets a on a.id = ps.asset_id
  where substring(ac.name from '(0x[0-9A-Fa-f]{40})') is not null
    and a.asset_class in ('crypto', 'stablecoin', 'gold', 'nft')
),
network_composition as (
  select
    owner_id,
    week_start,
    lower(wallet_address) as wallet_address,
    network,
    sum(value_usd)::numeric(24, 2) as network_value_usd,
    jsonb_agg(
      jsonb_build_object(
        'symbol', symbol,
        'name', asset_name,
        'asset_class', asset_class,
        'asset_id', asset_id,
        'contract_address', contract_address,
        'quantity', quantity,
        'price_usd', price_usd,
        'value_usd', value_usd,
        'observed_date', observed_date,
        'account', account_name,
        'source_key', source_key,
        'snapshot_kind', coalesce(metadata ->> 'snapshot_kind', 'observed')
      )
      order by value_usd desc, symbol
    ) as assets
  from wallet_positions
  where source_rank = 1
  group by owner_id, week_start, lower(wallet_address), network
)
select
  owner_id,
  week_start,
  wallet_address,
  sum(network_value_usd)::numeric(24, 2) as total_value_usd,
  jsonb_object_agg(
    network,
    jsonb_build_object(
      'total_value_usd', network_value_usd,
      'assets', assets
    )
    order by network
  ) as composition
from network_composition
group by owner_id, week_start, wallet_address;

revoke all on public.wallet_weekly_snapshot_json from anon;
grant select on public.wallet_weekly_snapshot_json to authenticated;

comment on view public.wallet_weekly_snapshot_json is
  'Readable weekly JSON projection of canonical position_snapshots: one wallet row with network and asset quantities, same-date prices, values, and provenance. Tuesday-to-Monday buckets combine chain observations without treating a zero chain as a zero wallet.';
