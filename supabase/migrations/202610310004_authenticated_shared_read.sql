create policy accounts_authenticated_read on public.accounts
for select to authenticated using (true);

create policy assets_authenticated_read on public.assets
for select to authenticated using (true);

create policy positions_authenticated_read on public.positions
for select to authenticated using (true);

create policy snapshots_authenticated_read on public.portfolio_snapshots
for select to authenticated using (true);

create policy sync_runs_authenticated_read on public.sync_runs
for select to authenticated using (true);

create policy position_snapshots_authenticated_read on public.position_snapshots
for select to authenticated using (true);

create policy brokerage_transactions_authenticated_read on public.brokerage_transactions
for select to authenticated using (true);

create policy spend_transactions_authenticated_read on public.spend_transactions
for select to authenticated using (true);

comment on policy positions_authenticated_read on public.positions is
  'All approved authenticated users can view the shared portfolio. Sign-ups are disabled; writes remain owner-scoped.';
