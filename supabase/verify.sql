-- RetailOS — check the install is sound.
--
-- Paste into the Supabase SQL Editor and press Run, any time you want to be
-- sure the database is as it should be: after running schema.sql, after
-- changing a policy, or when sync starts behaving oddly.
--
-- It writes nothing that it does not delete again, and it fails loudly
-- rather than returning a wall of rows to read. A clean run ends with one
-- row saying so.
--
-- The ::text on each problem matters: without it Postgres reads the string
-- as an array literal and raises a malformed-array error instead of the
-- message. Since those lines only run when something is wrong, dropping the
-- cast would make this script pass quietly for ever.

do $$
declare
  problems text[] := '{}';
  seen     int;
  amount   numeric;
begin

  /* ── the objects exist ── */

  if to_regclass('public.stores')  is null then problems := problems || 'the stores table is missing'::text; end if;
  if to_regclass('public.targets') is null then problems := problems || 'the targets table is missing'::text; end if;
  if not exists (select 1 from pg_views where schemaname = 'public' and viewname = 'targets_report')
    then problems := problems || 'the targets_report view is missing — Power BI reads that one'::text; end if;

  /* ── row-level security is the thing protecting the data ── */

  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname in ('stores','targets') and not c.relrowsecurity)
    then problems := problems || 'row-level security is OFF on a table — the publishable key would read everything'::text; end if;

  select count(*) into seen from pg_policies where schemaname = 'public' and tablename in ('stores','targets');
  if seen < 2 then problems := problems || 'a table has no policy, so even signed-in users read nothing'::text; end if;

  /* ── the anonymous role must not reach the data ──
     The publishable key in the browser is anon until somebody signs in.  */

  if has_table_privilege('anon','public.stores','select')
     or has_table_privilege('anon','public.targets','select')
     or has_table_privilege('anon','public.targets_report','select')
    then problems := problems || 'anon can read the data — anyone with the public key could too'::text; end if;

  if not (has_table_privilege('authenticated','public.stores','select')
          and has_table_privilege('authenticated','public.targets','insert'))
    then problems := problems || 'signed-in users cannot read or write — sync will fail'::text; end if;

  /* ── the constraints still reject what the app relies on them rejecting ── */

  begin insert into public.stores(store_id,store_name,store_channel) values ('VFY1','probe','Bazaar');
    problems := problems || 'any channel name is accepted'::text; exception when check_violation then null; end;

  begin insert into public.stores(store_id,store_name,open_date,close_date)
        values ('VFY2','probe','2026-05-01','2026-01-01');
    problems := problems || 'a store can close before it opens'::text; exception when check_violation then null; end;

  insert into public.stores(store_id,store_name) values ('VFY3','probe')
    on conflict (store_id) do nothing;

  begin insert into public.targets(store_id,month,sales) values ('VFY3','2026-03-15',1);
    problems := problems || 'a target can land mid-month, so there is more than one row per store-month'::text;
    exception when check_violation then null; end;

  begin insert into public.targets(store_id,month,conversion) values ('VFY3','2026-03-01',35);
    problems := problems || 'conversion is accepted as percentage points, not a fraction'::text;
    exception when check_violation then null; end;

  begin insert into public.targets(store_id,month,sales) values ('VFY3','2026-04-01',-5);
    problems := problems || 'a negative target is accepted'::text; exception when check_violation then null; end;

  /* ── what the app actually does, as the role it does it as ──
     Grants and policies are different checks: a role can hold the grant and
     still be refused by the policy. This runs the real thing.  */

  set local role authenticated;

  insert into public.stores(store_id,store_name,store_channel,status,updated_at,deleted)
  values ('VFY9','policy probe','Retail','active','2026-03-01T09:00:00Z',false)
  on conflict (store_id) do update set store_name = excluded.store_name;

  insert into public.targets(store_id,month,sales,traffic,conversion,upt,asp,sot,updated_at,deleted)
  values ('VFY9','2026-03-01',182000,23000,0.14,1.8,31.5,null,'2026-03-01T09:00:00Z',false)
  on conflict (store_id,month) do update set sales = excluded.sales;

  -- The same row again: this is every sync after the first one.
  insert into public.targets(store_id,month,sales,traffic,conversion,upt,asp,sot,updated_at,deleted)
  values ('VFY9','2026-03-01',999,23000,0.14,1.8,31.5,null,'2026-03-02T09:00:00Z',false)
  on conflict (store_id,month) do update set sales = excluded.sales, updated_at = excluded.updated_at;

  select count(*) into seen from public.targets_report where store_id = 'VFY9';
  if seen <> 1 then problems := problems || 'a signed-in user cannot read back what they just wrote'::text; end if;

  select sales_target into amount from public.targets_report where store_id = 'VFY9';
  if amount is distinct from 999 then problems := problems || 'a repeat sync does not overwrite the earlier value'::text; end if;

  -- Sales = Traffic x Conversion x UPT x ASP, worked out by the view.
  select implied_sales into amount from public.targets_report where store_id = 'VFY9';
  if amount is null or abs(amount - 182574) > 1
    then problems := problems || 'the view is not computing implied sales correctly'::text; end if;

  reset role;

  /* ── leave nothing behind ── */

  delete from public.targets where store_id like 'VFY%';
  delete from public.stores  where store_id like 'VFY%';

  if array_length(problems, 1) is null then
    raise notice 'All checks passed.';
  else
    raise exception E'\n  - %', array_to_string(problems, E'\n  - ');
  end if;
end $$;

select 'All checks passed. ' ||
       (select count(*) from public.stores  where not deleted) || ' stores, ' ||
       (select count(*) from public.targets where not deleted) || ' store-months.' as result;
