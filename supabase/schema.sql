-- RetailOS — Supabase schema.
--
-- Paste the whole file into the Supabase SQL Editor and press Run. It is
-- safe to run twice: every object is created only if it is not already
-- there, and the policies are dropped and recreated.
--
-- Two tables, shaped to match what the app already holds:
--   stores   — one row per store, keyed on the store ID you use everywhere
--   targets  — one row per store per calendar month, six target columns
--
-- Both carry updated_at and a deleted flag rather than really deleting, so
-- two devices can merge their changes in any order and the newer version of
-- a row wins. That is the same rule the offline app uses today.

-- ─────────────────────────── stores ───────────────────────────

create table if not exists public.stores (
  store_id      text primary key,
  store_name    text not null,
  store_manager text,
  store_channel text,
  country       text,
  status        text        not null default 'active',
  open_date     date,
  close_date    date,
  sales_area    numeric(10, 2),
  address       text,
  latitude      text,
  longitude     text,
  updated_at    timestamptz not null default now(),
  deleted       boolean     not null default false,

  constraint stores_status_known
    check (status in ('active', 'pipeline', 'closed')),
  constraint stores_channel_known
    check (store_channel is null or store_channel in
      ('Retail', 'Outlet', 'Concession', 'Franchise', 'Ecommerce', 'Pop-up')),
  constraint stores_closes_after_it_opens
    check (close_date is null or open_date is null or close_date >= open_date),

  -- Held as text so whatever precision was given survives exactly, but a
  -- value that is not a number in range is a typo, not a coordinate — and
  -- Power BI's map visuals cannot convert one. Checking here means a bad
  -- one is caught on the way in rather than showing up off the coast of
  -- Ghana, which is where 0,0 puts a store.
  constraint stores_latitude_is_a_coordinate
    check (latitude is null or
      (latitude ~ '^-?[0-9]{1,2}(\.[0-9]+)?$' and latitude::numeric between -90 and 90)),
  constraint stores_longitude_is_a_coordinate
    check (longitude is null or
      (longitude ~ '^-?[0-9]{1,3}(\.[0-9]+)?$' and longitude::numeric between -180 and 180))
);

comment on table  public.stores          is 'One row per store. The system of record for what the POS does not know.';
comment on column public.stores.store_id is 'Stable forever. Never reused, never renumbered — Power BI joins on this.';
comment on column public.stores.deleted  is 'A tombstone. Deleting for real would let an old device resurrect the row.';
-- Adding the columns to a database created before they existed. Harmless on
-- a fresh one, which already has them from the create table above. These
-- come before the comments on them, which would otherwise be the first
-- statement to fail on an upgrade.
alter table public.stores add column if not exists address   text;
alter table public.stores add column if not exists latitude  text;
alter table public.stores add column if not exists longitude text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_latitude_is_a_coordinate') then
    alter table public.stores add constraint stores_latitude_is_a_coordinate
      check (latitude is null or
        (latitude ~ '^-?[0-9]{1,2}(\.[0-9]+)?$' and latitude::numeric between -90 and 90));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stores_longitude_is_a_coordinate') then
    alter table public.stores add constraint stores_longitude_is_a_coordinate
      check (longitude is null or
        (longitude ~ '^-?[0-9]{1,3}(\.[0-9]+)?$' and longitude::numeric between -180 and 180));
  end if;
end $$;

comment on column public.stores.latitude is 'Decimal degrees as text, e.g. 55.7446675. Text so the given precision survives; Power BI converts.';
comment on column public.stores.longitude is 'Decimal degrees as text, e.g. 37.5658937. Negative is west.';

-- ─────────────────────────── targets ───────────────────────────

create table if not exists public.targets (
  store_id   text not null references public.stores (store_id) on update cascade,
  month      date not null,
  sales      numeric(14, 2),
  traffic    numeric(12, 2),
  conversion numeric(8, 6),
  upt        numeric(8, 4),
  asp        numeric(12, 4),
  sot        numeric(12, 4),
  updated_at timestamptz not null default now(),
  deleted    boolean     not null default false,

  primary key (store_id, month),

  -- Always the first of the month, so a date table joins cleanly and there
  -- is exactly one row per store-month rather than one per keying mistake.
  constraint targets_month_is_first_of_month
    check (month = date_trunc('month', month)::date),

  -- Conversion is a fraction, never percentage points. The app normalises
  -- 14, 0.14 and '14%' on the way in; this makes sure nothing else can't.
  constraint targets_conversion_is_a_fraction
    check (conversion is null or (conversion >= 0 and conversion <= 1)),

  constraint targets_are_not_negative
    check (
      (sales   is null or sales   >= 0) and
      (traffic is null or traffic >= 0) and
      (upt     is null or upt     >= 0) and
      (asp     is null or asp     >= 0)
    )
);

comment on table  public.targets       is 'Operational targets, one row per store per calendar month.';
comment on column public.targets.month is 'Always the first of the month. Calendar months, not a 4-5-4 retail calendar.';
comment on column public.targets.sot   is 'Sales / Traffic. Also equals conversion * upt * asp.';

create index if not exists targets_month_idx on public.targets (month);

-- ────────────────────── the view Power BI reads ──────────────────────
--
-- Live rows only, the store's name, channel and location already joined on,
-- and the two identities worked out so the consistency check is visible in the
-- report rather than only in the app:
--
--   Sales = Traffic x Conversion x UPT x ASP
--   SOT   = Sales / Traffic
--
-- security_invoker means the view obeys the row-level security below
-- instead of quietly running as its owner.

-- Dropped rather than replaced: `create or replace view` can only add
-- columns at the end of the list, so on a database that already has an
-- older version of this view, inserting the location columns after country
-- fails outright. Not cascade — if something ever does depend on this view,
-- that should stop the script, not be quietly deleted.
drop view if exists public.targets_report;

create view public.targets_report
with (security_invoker = on) as
select
  t.store_id,
  s.store_name,
  s.store_channel,
  s.country,
  s.address,
  s.latitude,
  s.longitude,
  t.month                                          as month_start,
  to_char(t.month, 'YYYY-MM')                      as month_key,
  t.sales                                          as sales_target,
  t.traffic                                        as traffic_target,
  t.conversion                                     as conversion_target,
  t.upt                                            as upt_target,
  t.asp                                            as asp_target,
  t.sot                                            as sot_target,
  round(t.traffic * t.conversion * t.upt * t.asp, 2) as implied_sales,
  case
    when t.sales is null or t.sales = 0 then null
    else round(
      ((t.traffic * t.conversion * t.upt * t.asp) - t.sales) / abs(t.sales) * 100, 4)
  end                                              as sales_variance_pct,
  case
    when t.traffic is null or t.traffic = 0 then null
    else round(t.sales / t.traffic, 4)
  end                                              as implied_sot,
  t.updated_at
from public.targets t
join public.stores  s on s.store_id = t.store_id
where not t.deleted
  and not s.deleted;

comment on view public.targets_report is 'Flat table for Power BI. Join actuals to store_id and month_start.';

-- ────────────────────── who may read and write ──────────────────────
--
-- Row-level security is on, and nothing is readable until a policy says so.
-- This matters more than it looks: the key the browser app carries is
-- public by design, so these policies — not the key — are what keeps the
-- data private.
--
-- Right now the rule is simply "anyone signed in". Everyone using it is at
-- HQ and sees everything anyway. When store managers get logins, this is
-- the one place that changes: narrow the using() clause to the stores that
-- person is allowed to see, and every query in the app narrows with it.

alter table public.stores  enable row level security;
alter table public.targets enable row level security;

drop policy if exists "signed-in users manage stores"  on public.stores;
drop policy if exists "signed-in users manage targets" on public.targets;

create policy "signed-in users manage stores"
  on public.stores for all
  to authenticated
  using (true)
  with check (true);

create policy "signed-in users manage targets"
  on public.targets for all
  to authenticated
  using (true)
  with check (true);

-- Signed out means nothing. No policy for the anon role is deliberate:
-- without one, a stranger holding the public key reads zero rows.

-- ────────────────────── grants, said out loud ──────────────────────
--
-- Supabase already grants new tables in public to these roles, so this is
-- belt and braces — but it is the difference between the file being correct
-- and the file relying on a default. Row-level security above still decides
-- which rows; this only decides which tables exist as far as a role is
-- concerned. anon is revoked explicitly: signed out is not a role that
-- reads anything here.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema public to authenticated;
    grant select, insert, update, delete on public.stores, public.targets to authenticated;
    grant select on public.targets_report to authenticated;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.stores, public.targets, public.targets_report from anon;
  end if;
end $$;

-- ─────────────────────────── check it worked ───────────────────────────
--
-- Both tables should come back with rowsecurity = true, and there should be
-- one policy on each, for the authenticated role.

-- select tablename, rowsecurity from pg_tables  where schemaname = 'public';
-- select tablename, policyname, roles from pg_policies where schemaname = 'public';
