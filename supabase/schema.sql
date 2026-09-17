-- =============================================================================
--  League Room — database schema
--
--  Run this whole file in Supabase → SQL Editor → New query → Run.
--  It is idempotent: safe on a brand-new project, and safe to re-run.
--
--  Security model
--   * Browsers use the public anon key, so that key is not a secret. Row Level
--     Security and column privileges are what actually protect the data.
--   * leagues / divisions are readable when the league is public or you belong
--     to it. Secret columns (invite codes, commissioner email, division
--     commissioner invite codes) are not readable by browsers at all;
--     commissioners fetch them through get_league_admin().
--   * Every write goes through a SECURITY DEFINER function below that checks
--     who is calling and whether the move is legal. No table accepts direct
--     inserts, updates or deletes from the browser.
--   * This file REPLACES any existing policies on the tables it manages.
--
--  Leagues hosted on the site
--   Scores are not stored. Every browser derives them the same way from public
--   NFL stats plus the lineup history kept here, and lineup changes are stamped
--   with the database clock, so nobody can backdate a lineup to start a player
--   who already scored.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Core tables (the external super-league site used these already)
-- -----------------------------------------------------------------------------

create table if not exists public.leagues (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  text not null unique,
  email                 text,
  commissioner_id       uuid,
  num_divisions         int  not null default 2,
  playoff_length_weeks  int  not null default 3,
  playoff_advance_count int  not null default 8,
  invite_code           text,
  is_public             boolean not null default false,
  finalized             boolean not null default false,
  created_at            timestamptz not null default now()
);
alter table public.leagues add column if not exists email      text;
alter table public.leagues add column if not exists finalized  boolean not null default false;
alter table public.leagues add column if not exists is_public  boolean not null default false;
alter table public.leagues add column if not exists created_at timestamptz not null default now();
alter table public.leagues add column if not exists sport      text not null default 'nfl';
alter table public.leagues add column if not exists format     text not null default 'super';
alter table public.leagues add column if not exists hosting    text not null default 'external';

create table if not exists public.divisions (
  id                 uuid primary key default gen_random_uuid(),
  league_id          uuid not null references public.leagues(id) on delete cascade,
  name               text not null,
  platform           text not null default 'sleeper',
  external_league_id text,
  sort_order         int  not null default 0,
  created_at         timestamptz not null default now()
);
alter table public.divisions add column if not exists sort_order          int not null default 0;
alter table public.divisions add column if not exists created_at          timestamptz not null default now();
alter table public.divisions add column if not exists commissioner_id     uuid;
alter table public.divisions add column if not exists commish_invite_code text;

create table if not exists public.espn_credentials (
  division_id uuid primary key references public.divisions(id) on delete cascade,
  espn_s2     text,
  swid        text
);

create table if not exists public.league_members (
  id        uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id   uuid not null,
  joined_at timestamptz not null default now()
);
alter table public.league_members add column if not exists joined_at timestamptz not null default now();

create table if not exists public.profiles (
  user_id      uuid primary key,
  display_name text not null,
  updated_at   timestamptz not null default now()
);

-- An older schema may have typed `platform` as an enum, or constrained the
-- columns this file needs to widen. Normalise both before adding our checks.
do $$
declare r record;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'divisions'
               and column_name = 'platform' and data_type = 'USER-DEFINED') then
    execute 'alter table public.divisions alter column platform type text using platform::text';
  end if;

  for r in
    select c.conname, c.conrelid::regclass::text as tbl
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in ('public.divisions'::regclass, 'public.leagues'::regclass)
      and (pg_get_constraintdef(c.oid) ilike '%platform%'
        or pg_get_constraintdef(c.oid) ilike '%num_divisions%'
        or pg_get_constraintdef(c.oid) ilike '%sport%'
        or pg_get_constraintdef(c.oid) ilike '%format%'
        or pg_get_constraintdef(c.oid) ilike '%hosting%')
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table public.leagues   add constraint leagues_sport_check   check (sport in ('nfl','nba','mlb','nhl','soccer'));
alter table public.leagues   add constraint leagues_format_check  check (format in ('super','single'));
alter table public.leagues   add constraint leagues_hosting_check check (hosting in ('external','hosted'));
alter table public.leagues   add constraint leagues_num_divisions_check check (num_divisions between 1 and 16);
alter table public.divisions add constraint divisions_platform_check
  check (platform in ('sleeper','espn','yahoo','nfl','manual','hosted'));

-- -----------------------------------------------------------------------------
-- Hosted-league tables. Each hosted division is a self-contained fantasy
-- league: its own teams, draft, player pool, waivers and trades.
-- -----------------------------------------------------------------------------

create table if not exists public.hosted_settings (
  division_id          uuid primary key references public.divisions(id) on delete cascade,
  season               text not null,
  team_count           int  not null check (team_count between 4 and 20),
  roster_slots         text[] not null,
  scoring_preset       text not null default 'ppr',
  scoring              jsonb not null default '{}'::jsonb,
  start_week           int  not null default 1  check (start_week between 1 and 18),
  regular_season_weeks int  not null default 14 check (regular_season_weeks between 1 and 18),
  waiver_hours         int  not null default 48 check (waiver_hours between 0 and 168),
  created_at           timestamptz not null default now()
);

create table if not exists public.hosted_teams (
  id              uuid primary key default gen_random_uuid(),
  division_id     uuid not null references public.divisions(id) on delete cascade,
  slot            int  not null,
  name            text not null,
  owner_id        uuid,
  waiver_priority int  not null,
  created_at      timestamptz not null default now(),
  unique (division_id, slot)
);

-- Current ownership. The primary key is what guarantees a player sits on at
-- most one roster per division.
create table if not exists public.hosted_rosters (
  division_id  uuid not null references public.divisions(id) on delete cascade,
  player_id    text not null,
  team_id      uuid not null references public.hosted_teams(id) on delete cascade,
  position     text,
  acquired_via text not null,
  acquired_at  timestamptz not null default now(),
  primary key (division_id, player_id)
);

-- Append-only. Each row is a full starting lineup, aligned to the division's
-- non-bench roster slots ('' = empty). Scoring replays these against kickoffs.
create table if not exists public.hosted_lineups (
  id         bigserial primary key,
  team_id    uuid not null references public.hosted_teams(id) on delete cascade,
  starters   text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists public.hosted_drafts (
  division_id             uuid primary key references public.divisions(id) on delete cascade,
  status                  text not null default 'scheduled' check (status in ('scheduled','drafting','complete')),
  draft_type              text not null default 'snake' check (draft_type in ('snake','linear')),
  rounds                  int  not null,
  pick_seconds            int  not null default 90,
  order_team_ids          uuid[] not null,
  started_at              timestamptz,
  completed_at            timestamptz,
  current_pick_started_at timestamptz
);

create table if not exists public.hosted_draft_picks (
  division_id uuid not null references public.divisions(id) on delete cascade,
  pick_no     int  not null,
  round       int  not null,
  team_id     uuid not null references public.hosted_teams(id) on delete cascade,
  player_id   text not null,
  made_by     uuid,
  made_at     timestamptz not null default now(),
  primary key (division_id, pick_no),
  unique (division_id, player_id)
);

-- A dropped player sits on waivers until clears_at.
create table if not exists public.hosted_waiver_locks (
  division_id uuid not null references public.divisions(id) on delete cascade,
  player_id   text not null,
  clears_at   timestamptz not null,
  primary key (division_id, player_id)
);

create table if not exists public.hosted_waiver_claims (
  id           bigserial primary key,
  division_id  uuid not null references public.divisions(id) on delete cascade,
  team_id      uuid not null references public.hosted_teams(id) on delete cascade,
  add_player   text not null,
  add_position text,
  drop_player  text,
  status       text not null default 'pending' check (status in ('pending','won','lost','invalid','cancelled')),
  note         text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.hosted_trades (
  id          bigserial primary key,
  division_id uuid not null references public.divisions(id) on delete cascade,
  from_team   uuid not null references public.hosted_teams(id) on delete cascade,
  to_team     uuid not null references public.hosted_teams(id) on delete cascade,
  give        text[] not null default '{}',   -- from_team sends these
  receive     text[] not null default '{}',   -- to_team sends these
  message     text,
  status      text not null default 'pending' check (status in ('pending','accepted','rejected','cancelled','failed')),
  note        text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.hosted_transactions (
  id            bigserial primary key,
  division_id   uuid not null references public.divisions(id) on delete cascade,
  kind          text not null,
  team_id       uuid,
  other_team_id uuid,
  adds          text[] not null default '{}',
  drops         text[] not null default '{}',
  details       jsonb,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index if not exists divisions_league_idx      on public.divisions(league_id);
create index if not exists league_members_user_idx   on public.league_members(user_id);
create index if not exists league_members_league_idx on public.league_members(league_id);
create index if not exists hosted_teams_division_idx on public.hosted_teams(division_id);
create unique index if not exists hosted_teams_one_team_per_owner
  on public.hosted_teams(division_id, owner_id) where owner_id is not null;
create index if not exists hosted_rosters_team_idx   on public.hosted_rosters(team_id);
create index if not exists hosted_lineups_team_idx   on public.hosted_lineups(team_id, created_at, id);
create index if not exists hosted_claims_div_idx     on public.hosted_waiver_claims(division_id, status);
create index if not exists hosted_trades_div_idx     on public.hosted_trades(division_id, status);
create index if not exists hosted_tx_div_idx         on public.hosted_transactions(division_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Clear out earlier versions
--
-- Earlier versions of this site defined some of these functions with different
-- parameter names or return types, which CREATE OR REPLACE cannot change
-- (e.g. join_league_by_code once took p_password). Existing policies on these
-- tables are dropped first because they may depend on those functions; the
-- policies this file wants are recreated at the end.
-- -----------------------------------------------------------------------------

do $$
declare pol record; fn record;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('leagues','divisions','espn_credentials','league_members','profiles',
                        'hosted_settings','hosted_teams','hosted_rosters','hosted_lineups','hosted_drafts',
                        'hosted_draft_picks','hosted_waiver_locks','hosted_waiver_claims','hosted_trades',
                        'hosted_transactions')
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;

  for fn in
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in (
        '_require_uid','_slugify','_random_code','_random_digits6','_add_member','_ctx','_is_commish',
        '_lock_division','_assert_commish','_assert_team_control','_max_roster','_starting_slots',
        '_assert_draft_complete','_valid_player_id','_valid_position','_slot_eligible','_remove_from_lineup',
        '_lock_waiver','_log','_draft_team_for_pick','_autofill_lineups','_process_waivers',
        'is_league_member','can_view_league','set_display_name','get_my_profile','create_league',
        'join_league_by_code','get_league_admin','update_league_settings','set_league_finalized',
        'create_division_commish_invite','remove_division_commissioner','claim_division_commissioner',
        'hosted_division_state','hosted_lineup_history','hosted_transactions_list','claim_hosted_team',
        'rename_hosted_team','release_hosted_team','set_hosted_lineup','hosted_add_player','hosted_drop_player',
        'hosted_submit_claim','hosted_cancel_claim','hosted_propose_trade','hosted_respond_trade',
        'hosted_cancel_trade','hosted_draft_set_order','hosted_draft_randomize','hosted_draft_start',
        'hosted_draft_pick','hosted_draft_undo','hosted_update_settings')
  loop
    execute 'drop function ' || fn.sig;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Helpers (names starting with "_" are internal and not callable by browsers)
-- -----------------------------------------------------------------------------

create or replace function public._require_uid() returns uuid
language plpgsql stable set search_path = public as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'You need to be logged in to do that.';
  end if;
  return v;
end $$;

create or replace function public._slugify(p text) returns text
language sql immutable as $$
  select left(trim(both '-' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g')), 60)
$$;

-- Unguessable codes come from gen_random_uuid(), which uses a strong RNG.
create or replace function public._random_code(p_len int) returns text
language sql volatile as $$
  select left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), p_len)
$$;

create or replace function public._random_digits6() returns text
language sql volatile as $$
  select lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))::bit(28)::int) % 1000000)::text, 6, '0')
$$;

create or replace function public.is_league_member(p_league_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
       exists (select 1 from public.leagues l where l.id = p_league_id and l.commissioner_id = auth.uid())
    or exists (select 1 from public.league_members m where m.league_id = p_league_id and m.user_id = auth.uid())
    or exists (select 1 from public.divisions d where d.league_id = p_league_id and d.commissioner_id = auth.uid())
    or exists (select 1 from public.hosted_teams t join public.divisions d on d.id = t.division_id
               where d.league_id = p_league_id and t.owner_id = auth.uid())
  )
$$;

create or replace function public.can_view_league(p_league_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.leagues l where l.id = p_league_id and l.is_public)
      or public.is_league_member(p_league_id)
$$;

create or replace function public._add_member(p_league_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from league_members m where m.league_id = p_league_id and m.user_id = p_user) then
    insert into league_members(league_id, user_id) values (p_league_id, p_user);
  end if;
end $$;

-- Resolves a hosted division, or fails with a friendly message.
create or replace function public._ctx(
  p_division_id uuid,
  out division_id uuid, out league_id uuid, out league_commish uuid,
  out division_commish uuid, out is_public boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  select d.id, d.league_id, l.commissioner_id, d.commissioner_id, l.is_public
    into division_id, league_id, league_commish, division_commish, is_public
  from public.divisions d join public.leagues l on l.id = d.league_id
  where d.id = p_division_id and d.platform = 'hosted';
  if not found then
    raise exception 'That league could not be found.';
  end if;
end $$;

-- League commissioners have authority over every division; division
-- commissioners over their own.
create or replace function public._is_commish(p_division_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.divisions d join public.leagues l on l.id = d.league_id
    where d.id = p_division_id
      and (l.commissioner_id = auth.uid() or d.commissioner_id = auth.uid()))
$$;

-- Serialises every roster-changing operation within a division, so two
-- managers can never both win the same player.
create or replace function public._lock_division(p_division_id uuid) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended(p_division_id::text, 42))
$$;

create or replace function public._assert_commish(p_division_id uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_uid();
  if not public._is_commish(p_division_id) then
    raise exception 'Only a commissioner can do that.';
  end if;
end $$;

-- Returns the team's division when the caller manages it (or is a commissioner).
create or replace function public._assert_team_control(p_team_id uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_div uuid; v_owner uuid; v_uid uuid := public._require_uid();
begin
  select t.division_id, t.owner_id into v_div, v_owner from public.hosted_teams t where t.id = p_team_id;
  if not found then
    raise exception 'That team could not be found.';
  end if;
  if v_owner is distinct from v_uid and not public._is_commish(v_div) then
    raise exception 'Only this team''s manager or a commissioner can do that.';
  end if;
  return v_div;
end $$;

create or replace function public._max_roster(p_division_id uuid) returns int
language sql stable security definer set search_path = public as $$
  select cardinality(s.roster_slots) from public.hosted_settings s where s.division_id = p_division_id
$$;

create or replace function public._starting_slots(p_division_id uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(u.slot order by u.ord), '{}')
  from public.hosted_settings hs, unnest(hs.roster_slots) with ordinality as u(slot, ord)
  where hs.division_id = p_division_id and u.slot <> 'BN'
$$;

create or replace function public._assert_draft_complete(p_division_id uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.hosted_drafts d where d.division_id = p_division_id and d.status = 'complete') then
    raise exception 'Rosters are locked until the draft is complete.';
  end if;
end $$;

create or replace function public._valid_player_id(p text) returns boolean
language sql immutable as $$
  select coalesce(p ~ '^([0-9]{1,10}|[A-Z]{2,4})$', false)
$$;

create or replace function public._valid_position(p text) returns boolean
language sql immutable as $$
  select p is null or p in ('QB','RB','WR','TE','K','DEF')
$$;

create or replace function public._slot_eligible(p_slot text, p_pos text) returns boolean
language sql immutable as $$
  select case
    when p_slot = 'BN'         then true
    when p_pos is null         then true   -- unknown position: the scorer has the final say
    when p_slot = 'FLEX'       then p_pos in ('RB','WR','TE')
    when p_slot = 'SUPER_FLEX' then p_pos in ('QB','RB','WR','TE')
    when p_slot = 'WRRB_FLEX'  then p_pos in ('RB','WR')
    when p_slot = 'REC_FLEX'   then p_pos in ('WR','TE')
    else p_slot = p_pos
  end
$$;

-- A player leaving a roster must also leave that team's lineup, or the old
-- team could keep scoring him after a trade.
create or replace function public._remove_from_lineup(p_team_id uuid, p_player_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v text[];
begin
  select l.starters into v from public.hosted_lineups l
  where l.team_id = p_team_id order by l.created_at desc, l.id desc limit 1;
  if v is not null and p_player_id = any(v) then
    insert into public.hosted_lineups(team_id, starters) values (p_team_id, array_replace(v, p_player_id, ''));
  end if;
end $$;

create or replace function public._lock_waiver(p_division_id uuid, p_player_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v_hours int;
begin
  select s.waiver_hours into v_hours from public.hosted_settings s where s.division_id = p_division_id;
  if coalesce(v_hours, 0) <= 0 then
    return;
  end if;
  insert into public.hosted_waiver_locks(division_id, player_id, clears_at)
  values (p_division_id, p_player_id, now() + make_interval(hours => v_hours))
  on conflict (division_id, player_id)
  do update set clears_at = greatest(public.hosted_waiver_locks.clears_at, excluded.clears_at);
end $$;

create or replace function public._log(
  p_division_id uuid, p_kind text, p_team uuid, p_other uuid,
  p_adds text[], p_drops text[], p_details jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.hosted_transactions(division_id, kind, team_id, other_team_id, adds, drops, details, created_by)
  values (p_division_id, p_kind, p_team, p_other, coalesce(p_adds, '{}'), coalesce(p_drops, '{}'), p_details, auth.uid())
$$;

-- Snake or linear: which team owns overall pick p_pick_no.
create or replace function public._draft_team_for_pick(p_division_id uuid, p_pick_no int) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare d record; v_n int; v_round int; v_idx int;
begin
  select * into d from public.hosted_drafts x where x.division_id = p_division_id;
  v_n := cardinality(d.order_team_ids);
  v_round := ((p_pick_no - 1) / v_n) + 1;
  v_idx := (p_pick_no - 1) % v_n;
  if d.draft_type = 'snake' and v_round % 2 = 0 then
    v_idx := v_n - 1 - v_idx;
  end if;
  return d.order_team_ids[v_idx + 1];
end $$;

-- After the draft, give every team a starting lineup so an absent manager
-- still fields a team. Positional slots fill first, flex slots after, each
-- with the earliest-drafted eligible player.
create or replace function public._autofill_lineups(p_division_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_slots text[] := public._starting_slots(p_division_id);
  v_team record; v_starters text[]; v_used text[]; v_pass int; i int; v_pick text;
begin
  for v_team in select t.id from public.hosted_teams t where t.division_id = p_division_id loop
    continue when exists (select 1 from public.hosted_lineups l where l.team_id = v_team.id);
    v_starters := array_fill(''::text, array[cardinality(v_slots)]);
    v_used := '{}';
    for v_pass in 1..2 loop
      for i in 1..cardinality(v_slots) loop
        continue when (v_pass = 1) = (v_slots[i] like '%FLEX%');
        select r.player_id into v_pick
        from public.hosted_rosters r
        left join public.hosted_draft_picks dp on dp.division_id = r.division_id and dp.player_id = r.player_id
        where r.team_id = v_team.id and r.position is not null
          and not (r.player_id = any(v_used))
          and public._slot_eligible(v_slots[i], r.position)
        order by dp.pick_no nulls last, r.acquired_at
        limit 1;
        if found then
          v_starters[i] := v_pick;
          v_used := v_used || v_pick;
        end if;
      end loop;
    end loop;
    insert into public.hosted_lineups(team_id, starters) values (v_team.id, v_starters);
  end loop;
end $$;

-- Rolling-priority waivers. Called lazily whenever a division is loaded, so
-- no scheduler is needed: claims resolve the first time anyone looks after a
-- player's waiver period ends. Results don't depend on who triggers it.
create or replace function public._process_waivers(p_division_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_claim record; v_max int; v_team_count int; v_size int; v_count int := 0;
begin
  perform public._lock_division(p_division_id);
  select cardinality(s.roster_slots), s.team_count into v_max, v_team_count
  from public.hosted_settings s where s.division_id = p_division_id;
  if v_max is null then
    return 0;
  end if;

  loop
    select c.id, c.team_id, c.add_player, c.add_position, c.drop_player, t.waiver_priority as prio
      into v_claim
    from public.hosted_waiver_claims c
    join public.hosted_teams t on t.id = c.team_id
    where c.division_id = p_division_id and c.status = 'pending'
      and not exists (select 1 from public.hosted_waiver_locks w
                      where w.division_id = c.division_id and w.player_id = c.add_player and w.clears_at > now())
    order by t.waiver_priority, c.created_at, c.id
    limit 1;
    exit when not found;

    if exists (select 1 from public.hosted_rosters r where r.division_id = p_division_id and r.player_id = v_claim.add_player) then
      update public.hosted_waiver_claims set status = 'lost', note = 'That player was already on a roster.', processed_at = now()
      where id = v_claim.id;
      continue;
    end if;
    if v_claim.drop_player is not null and not exists (
         select 1 from public.hosted_rosters r where r.team_id = v_claim.team_id and r.player_id = v_claim.drop_player) then
      update public.hosted_waiver_claims set status = 'invalid', note = 'The player you chose to drop was no longer on your roster.', processed_at = now()
      where id = v_claim.id;
      continue;
    end if;
    select count(*) into v_size from public.hosted_rosters r where r.team_id = v_claim.team_id;
    if v_size - (case when v_claim.drop_player is null then 0 else 1 end) + 1 > v_max then
      update public.hosted_waiver_claims set status = 'invalid', note = 'Your roster was full, so the claim needed a player to drop.', processed_at = now()
      where id = v_claim.id;
      continue;
    end if;

    if v_claim.drop_player is not null then
      delete from public.hosted_rosters r where r.team_id = v_claim.team_id and r.player_id = v_claim.drop_player;
      perform public._remove_from_lineup(v_claim.team_id, v_claim.drop_player);
      perform public._lock_waiver(p_division_id, v_claim.drop_player);
    end if;
    insert into public.hosted_rosters(division_id, player_id, team_id, position, acquired_via)
    values (p_division_id, v_claim.add_player, v_claim.team_id, v_claim.add_position, 'waiver');

    update public.hosted_waiver_claims set status = 'won', processed_at = now() where id = v_claim.id;
    update public.hosted_waiver_claims set status = 'lost', note = 'A team with higher waiver priority claimed him.', processed_at = now()
    where division_id = p_division_id and status = 'pending' and add_player = v_claim.add_player;

    -- The winner drops to the back of the line; everyone behind moves up one.
    update public.hosted_teams set waiver_priority = waiver_priority - 1
    where division_id = p_division_id and waiver_priority > v_claim.prio;
    update public.hosted_teams set waiver_priority = v_team_count where id = v_claim.team_id;

    perform public._log(p_division_id, 'waiver', v_claim.team_id, null, array[v_claim.add_player],
      case when v_claim.drop_player is null then '{}'::text[] else array[v_claim.drop_player] end, null);
    v_count := v_count + 1;
  end loop;

  delete from public.hosted_waiver_locks w
  where w.division_id = p_division_id and w.clears_at <= now()
    and not exists (select 1 from public.hosted_waiver_claims c
                    where c.division_id = w.division_id and c.add_player = w.player_id and c.status = 'pending');
  return v_count;
end $$;

-- -----------------------------------------------------------------------------
-- Accounts
-- -----------------------------------------------------------------------------

create or replace function public.set_display_name(p_display_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid(); v text := trim(coalesce(p_display_name, ''));
begin
  if char_length(v) < 2 or char_length(v) > 30 then
    raise exception 'Display names must be between 2 and 30 characters.';
  end if;
  insert into public.profiles(user_id, display_name) values (v_uid, v)
  on conflict (user_id) do update set display_name = excluded.display_name, updated_at = now();
end $$;

create or replace function public.get_my_profile() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public._require_uid();
begin
  return (select jsonb_build_object('user_id', v_uid, 'display_name', p.display_name)
          from public.profiles p where p.user_id = v_uid);
end $$;

-- -----------------------------------------------------------------------------
-- Leagues
-- -----------------------------------------------------------------------------

create or replace function public.create_league(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid        uuid := public._require_uid();
  v_name       text := trim(coalesce(p->>'name', ''));
  v_format     text := coalesce(p->>'format', 'super');
  v_hosting    text := coalesce(p->>'hosting', 'external');
  v_sport      text := coalesce(p->>'sport', 'nfl');
  v_divs       jsonb := coalesce(p->'divisions', '[]'::jsonb);
  v_playoff_wk int  := coalesce((p->>'playoff_length_weeks')::int, 3);
  v_advance    int  := coalesce((p->>'playoff_advance_count')::int, 4);
  v_invite_div boolean := coalesce((p->>'invite_commissioners')::boolean, false);
  v_claim_team boolean := coalesce((p->>'claim_team')::boolean, false);
  h            jsonb := coalesce(p->'hosted', '{}'::jsonb);
  v_ndiv int; v_slug text; v_base text; v_n int := 1;
  v_league uuid; v_div uuid; v_d jsonb; v_i int := 0; v_platform text;
  v_slots text[]; v_team_count int; v_weeks int; v_start int; v_waiver int; v_pick_sec int;
  v_season text; v_scoring jsonb; v_preset text; v_draft_type text;
  v_team uuid; v_team_ids uuid[]; s text; k int;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    raise exception 'League names must be between 2 and 60 characters.';
  end if;
  if v_format not in ('super', 'single') then raise exception 'Unknown league format.'; end if;
  if v_hosting not in ('external', 'hosted') then raise exception 'Unknown hosting option.'; end if;
  if v_sport not in ('nfl', 'nba', 'mlb', 'nhl', 'soccer') then raise exception 'Unknown sport.'; end if;
  if jsonb_typeof(v_divs) <> 'array' then raise exception 'Divisions must be a list.'; end if;
  if v_playoff_wk < 1 or v_playoff_wk > 6 then raise exception 'Playoffs must last between 1 and 6 weeks.'; end if;
  if v_advance < 2 or v_advance > 64 then raise exception 'Between 2 and 64 teams can make the playoffs.'; end if;
  v_ndiv := jsonb_array_length(v_divs);

  if v_format = 'single' then
    v_hosting := 'hosted';
    if v_ndiv <> 1 then raise exception 'A single-division league has exactly one division.'; end if;
  elsif v_ndiv < 2 or v_ndiv > 16 then
    raise exception 'A super league needs between 2 and 16 divisions.';
  end if;

  if v_hosting = 'hosted' then
    if v_sport <> 'nfl' then
      raise exception 'Leagues hosted on this site are football-only for now, because live scoring comes from NFL stats.';
    end if;
    v_team_count := coalesce((h->>'team_count')::int, 10);
    v_weeks      := coalesce((h->>'regular_season_weeks')::int, 14);
    v_start      := coalesce((h->>'start_week')::int, 1);
    v_waiver     := coalesce((h->>'waiver_hours')::int, 48);
    v_pick_sec   := coalesce((h->>'pick_seconds')::int, 90);
    v_season     := coalesce(nullif(h->>'season', ''), extract(year from now())::text);
    v_preset     := coalesce(nullif(h->>'scoring_preset', ''), 'ppr');
    v_scoring    := coalesce(h->'scoring', '{}'::jsonb);
    v_draft_type := coalesce(nullif(h->>'draft_type', ''), 'snake');
    select coalesce(array_agg(x), '{}') into v_slots
    from jsonb_array_elements_text(coalesce(h->'roster_slots', '[]'::jsonb)) x;

    if v_team_count < 4 or v_team_count > 20 then raise exception 'Teams per division must be between 4 and 20.'; end if;
    if v_start < 1 or v_start > 18 or v_weeks < 1 or v_start + v_weeks - 1 > 18 then
      raise exception 'The regular season has to fit inside NFL weeks 1–18.';
    end if;
    if v_waiver < 0 or v_waiver > 168 then raise exception 'The waiver period must be between 0 and 168 hours.'; end if;
    if v_pick_sec < 15 or v_pick_sec > 86400 then raise exception 'The pick timer must be between 15 seconds and 24 hours.'; end if;
    if v_draft_type not in ('snake', 'linear') then raise exception 'Unknown draft type.'; end if;
    if jsonb_typeof(v_scoring) <> 'object' then raise exception 'Scoring settings are invalid.'; end if;
    if v_season !~ '^[0-9]{4}$' then raise exception 'Season must be a year.'; end if;
    if cardinality(v_slots) < 5 or cardinality(v_slots) > 30 then raise exception 'Rosters need between 5 and 30 spots.'; end if;
    foreach s in array v_slots loop
      if s not in ('QB','RB','WR','TE','K','DEF','FLEX','SUPER_FLEX','WRRB_FLEX','REC_FLEX','BN') then
        raise exception 'Unknown roster spot: %', s;
      end if;
    end loop;
    if not exists (select 1 from unnest(v_slots) x where x <> 'BN') then
      raise exception 'Rosters need at least one starting spot.';
    end if;
  end if;

  v_base := public._slugify(v_name);
  if char_length(v_base) < 2 then
    raise exception 'Use a league name with at least a couple of letters or numbers.';
  end if;
  v_slug := v_base;
  -- "test-league" is a built-in league defined in the site itself.
  while exists (select 1 from public.leagues l where l.slug = v_slug) or v_slug = 'test-league' loop
    v_n := v_n + 1;
    v_slug := left(v_base, 55) || '-' || v_n;
  end loop;

  insert into public.leagues(name, slug, email, commissioner_id, num_divisions, playoff_length_weeks,
                             playoff_advance_count, invite_code, is_public, sport, format, hosting)
  values (v_name, v_slug, (select u.email from auth.users u where u.id = v_uid), v_uid, v_ndiv, v_playoff_wk,
          v_advance, public._random_digits6(), coalesce((p->>'is_public')::boolean, false),
          v_sport, v_format, v_hosting)
  returning id into v_league;

  perform public._add_member(v_league, v_uid);

  for v_d in select * from jsonb_array_elements(v_divs) loop
    v_i := v_i + 1;
    v_platform := case when v_hosting = 'hosted' then 'hosted' else coalesce(v_d->>'platform', 'sleeper') end;
    if v_platform not in ('sleeper', 'espn', 'yahoo', 'nfl', 'manual', 'hosted') then
      raise exception 'Division % has an unknown platform.', v_i;
    end if;

    insert into public.divisions(league_id, name, platform, external_league_id, sort_order, commish_invite_code)
    values (
      v_league,
      coalesce(nullif(left(trim(coalesce(v_d->>'name', '')), 60), ''), 'Division ' || v_i),
      v_platform,
      case when v_hosting = 'hosted' then null else nullif(trim(coalesce(v_d->>'external_league_id', '')), '') end,
      v_i - 1,
      case when v_hosting = 'hosted' and v_format = 'super' and v_invite_div then public._random_code(12) end
    )
    returning id into v_div;

    if v_hosting = 'external' then
      if v_platform = 'espn' and coalesce(v_d->>'espn_s2', '') <> '' and coalesce(v_d->>'swid', '') <> '' then
        insert into public.espn_credentials(division_id, espn_s2, swid) values (v_div, v_d->>'espn_s2', v_d->>'swid');
      end if;
    else
      insert into public.hosted_settings(division_id, season, team_count, roster_slots, scoring_preset, scoring,
                                         start_week, regular_season_weeks, waiver_hours)
      values (v_div, v_season, v_team_count, v_slots, v_preset, v_scoring, v_start, v_weeks, v_waiver);

      v_team_ids := '{}';
      for k in 1..v_team_count loop
        insert into public.hosted_teams(division_id, slot, name, waiver_priority)
        values (v_div, k, 'Team ' || k, k)
        returning id into v_team;
        v_team_ids := v_team_ids || v_team;
      end loop;

      insert into public.hosted_drafts(division_id, status, draft_type, rounds, pick_seconds, order_team_ids)
      values (v_div, 'scheduled', v_draft_type, cardinality(v_slots), v_pick_sec, v_team_ids);

      if v_claim_team and v_i = 1 then
        update public.hosted_teams set owner_id = v_uid where division_id = v_div and slot = 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('id', v_league, 'slug', v_slug);
end $$;

create or replace function public.join_league_by_code(p_code text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid(); v_id uuid; v_slug text;
begin
  select l.id, l.slug into v_id, v_slug from public.leagues l
  where l.invite_code = trim(coalesce(p_code, ''))
    and lower(trim(l.name)) = lower(trim(coalesce(p_name, '')));
  if not found then
    raise exception 'No league matches that name and invite code. Double-check both with your commissioner.';
  end if;
  perform public._add_member(v_id, v_uid);
  return v_slug;
end $$;

create or replace function public.get_league_admin(p_league_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public._require_uid();
begin
  if not exists (select 1 from public.leagues l where l.id = p_league_id and l.commissioner_id = v_uid) then
    raise exception 'Only the league commissioner can see this.';
  end if;
  return (
    select jsonb_build_object(
      'invite_code', l.invite_code,
      'member_count', (select count(*) from public.league_members m where m.league_id = l.id),
      'divisions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', d.id, 'name', d.name, 'platform', d.platform, 'external_league_id', d.external_league_id,
          'commissioner_id', d.commissioner_id,
          'commissioner_name', (select pr.display_name from public.profiles pr where pr.user_id = d.commissioner_id),
          'commish_invite_code', d.commish_invite_code,
          'teams_total', (select count(*) from public.hosted_teams t where t.division_id = d.id),
          'teams_claimed', (select count(*) from public.hosted_teams t where t.division_id = d.id and t.owner_id is not null)
        ) order by d.sort_order)
        from public.divisions d where d.league_id = l.id), '[]'::jsonb))
    from public.leagues l where l.id = p_league_id);
end $$;

create or replace function public.update_league_settings(
  p_league_id uuid, p_playoff_length_weeks int, p_playoff_advance_count int, p_is_public boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid();
begin
  if not exists (select 1 from public.leagues l where l.id = p_league_id and l.commissioner_id = v_uid) then
    raise exception 'Only the league commissioner can change settings.';
  end if;
  if p_playoff_length_weeks < 1 or p_playoff_length_weeks > 6 then raise exception 'Playoffs must last between 1 and 6 weeks.'; end if;
  if p_playoff_advance_count < 2 or p_playoff_advance_count > 64 then raise exception 'Between 2 and 64 teams can make the playoffs.'; end if;
  update public.leagues
  set playoff_length_weeks = p_playoff_length_weeks,
      playoff_advance_count = p_playoff_advance_count,
      is_public = coalesce(p_is_public, is_public)
  where id = p_league_id;
end $$;

create or replace function public.set_league_finalized(p_league_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid();
begin
  if not exists (select 1 from public.leagues l where l.id = p_league_id and l.commissioner_id = v_uid) then
    raise exception 'Only the league commissioner can finalize the league.';
  end if;
  update public.leagues set finalized = true where id = p_league_id;
end $$;

-- -----------------------------------------------------------------------------
-- Division commissioners
-- -----------------------------------------------------------------------------

create or replace function public.create_division_commish_invite(p_division_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid(); v_code text := public._random_code(12);
begin
  if not exists (select 1 from public.divisions d join public.leagues l on l.id = d.league_id
                 where d.id = p_division_id and l.commissioner_id = v_uid) then
    raise exception 'Only the league commissioner can invite division commissioners.';
  end if;
  update public.divisions set commish_invite_code = v_code where id = p_division_id;
  return v_code;
end $$;

create or replace function public.remove_division_commissioner(p_division_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid();
begin
  if not exists (select 1 from public.divisions d join public.leagues l on l.id = d.league_id
                 where d.id = p_division_id and l.commissioner_id = v_uid) then
    raise exception 'Only the league commissioner can remove a division commissioner.';
  end if;
  update public.divisions set commissioner_id = null where id = p_division_id;
end $$;

-- Invite codes are single use: claiming one consumes it.
create or replace function public.claim_division_commissioner(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid(); v_div uuid; v_league uuid; v_current uuid; v_slug text;
begin
  select d.id, d.league_id, d.commissioner_id, l.slug into v_div, v_league, v_current, v_slug
  from public.divisions d join public.leagues l on l.id = d.league_id
  where d.commish_invite_code = trim(coalesce(p_code, ''));
  if not found then
    raise exception 'That commissioner invite is invalid or has already been used.';
  end if;
  if v_current is not null and v_current <> v_uid then
    raise exception 'This division already has a commissioner.';
  end if;
  update public.divisions set commissioner_id = v_uid, commish_invite_code = null where id = v_div;
  perform public._add_member(v_league, v_uid);
  return jsonb_build_object('slug', v_slug, 'division_id', v_div);
end $$;

-- -----------------------------------------------------------------------------
-- Hosted leagues: reading
-- -----------------------------------------------------------------------------

create or replace function public.hosted_division_state(p_division_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c record;
  v_uid uuid := auth.uid();
  v_team uuid;
  v_commish boolean;
begin
  select * into c from public._ctx(p_division_id);
  if not public.can_view_league(c.league_id) then
    raise exception 'This league is private. Join it with an invite code to see it.';
  end if;

  perform public._process_waivers(p_division_id);

  v_commish := public._is_commish(p_division_id);
  if v_uid is not null then
    select t.id into v_team from public.hosted_teams t where t.division_id = p_division_id and t.owner_id = v_uid;
  end if;

  return jsonb_build_object(
    'server_time', now(),
    'league', (select jsonb_build_object(
        'id', l.id, 'slug', l.slug, 'name', l.name, 'is_public', l.is_public, 'sport', l.sport,
        'format', l.format, 'hosting', l.hosting, 'commissioner_id', l.commissioner_id,
        'playoff_advance_count', l.playoff_advance_count, 'playoff_length_weeks', l.playoff_length_weeks)
      from public.leagues l where l.id = c.league_id),
    'division', (select jsonb_build_object(
        'id', d.id, 'name', d.name, 'commissioner_id', d.commissioner_id,
        'commissioner_name', (select pr.display_name from public.profiles pr where pr.user_id = d.commissioner_id))
      from public.divisions d where d.id = p_division_id),
    'settings', (select to_jsonb(s) - 'division_id' from public.hosted_settings s where s.division_id = p_division_id),
    'me', jsonb_build_object(
      'user_id', v_uid,
      'is_member', coalesce(public.is_league_member(c.league_id), false),
      'is_commissioner', v_commish,
      'team_id', v_team),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'slot', t.slot, 'name', t.name, 'owner_id', t.owner_id,
        'owner_name', case when t.owner_id is null then null else coalesce(pr.display_name, 'Manager') end,
        'waiver_priority', t.waiver_priority,
        'roster', coalesce((
          select jsonb_agg(jsonb_build_object(
            'player_id', r.player_id, 'position', r.position,
            'acquired_at', r.acquired_at, 'acquired_via', r.acquired_via) order by r.acquired_at, r.player_id)
          from public.hosted_rosters r where r.team_id = t.id), '[]'::jsonb)
      ) order by t.slot)
      from public.hosted_teams t left join public.profiles pr on pr.user_id = t.owner_id
      where t.division_id = p_division_id), '[]'::jsonb),
    'draft', (select jsonb_build_object(
        'status', dr.status, 'draft_type', dr.draft_type, 'rounds', dr.rounds, 'pick_seconds', dr.pick_seconds,
        'order_team_ids', to_jsonb(dr.order_team_ids), 'started_at', dr.started_at,
        'completed_at', dr.completed_at, 'current_pick_started_at', dr.current_pick_started_at,
        'picks', coalesce((
          select jsonb_agg(jsonb_build_object(
            'pick_no', pk.pick_no, 'round', pk.round, 'team_id', pk.team_id,
            'player_id', pk.player_id, 'made_at', pk.made_at) order by pk.pick_no)
          from public.hosted_draft_picks pk where pk.division_id = p_division_id), '[]'::jsonb))
      from public.hosted_drafts dr where dr.division_id = p_division_id),
    'locks', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', w.player_id, 'clears_at', w.clears_at))
      from public.hosted_waiver_locks w
      where w.division_id = p_division_id and w.clears_at > now()), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', cl.id, 'team_id', cl.team_id, 'add_player', cl.add_player, 'drop_player', cl.drop_player,
        'status', cl.status, 'note', cl.note, 'created_at', cl.created_at, 'processed_at', cl.processed_at)
        order by cl.created_at desc)
      from public.hosted_waiver_claims cl
      where cl.division_id = p_division_id and cl.team_id = v_team
        and (cl.status = 'pending' or cl.processed_at > now() - interval '7 days')), '[]'::jsonb),
    'trades', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', tr.id, 'from_team', tr.from_team, 'to_team', tr.to_team,
        'give', to_jsonb(tr.give), 'receive', to_jsonb(tr.receive), 'message', tr.message,
        'status', tr.status, 'note', tr.note, 'created_at', tr.created_at, 'resolved_at', tr.resolved_at)
        order by tr.created_at desc)
      from public.hosted_trades tr
      where tr.division_id = p_division_id
        and (tr.from_team = v_team or tr.to_team = v_team or (v_commish and tr.status = 'pending'))
        and (tr.status = 'pending' or tr.resolved_at > now() - interval '14 days')), '[]'::jsonb)
  );
end $$;

create or replace function public.hosted_lineup_history(p_division_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c record;
begin
  select * into c from public._ctx(p_division_id);
  if not public.can_view_league(c.league_id) then
    raise exception 'This league is private.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'team_id', l.team_id, 'starters', to_jsonb(l.starters), 'created_at', l.created_at)
      order by l.created_at, l.id)
    from public.hosted_lineups l join public.hosted_teams t on t.id = l.team_id
    where t.division_id = p_division_id), '[]'::jsonb);
end $$;

create or replace function public.hosted_transactions_list(p_division_id uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c record;
begin
  select * into c from public._ctx(p_division_id);
  if not public.can_view_league(c.league_id) then
    raise exception 'This league is private.';
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc, x.id desc) from (
      select tx.id, tx.created_at, jsonb_build_object(
        'id', tx.id, 'kind', tx.kind, 'team_id', tx.team_id, 'other_team_id', tx.other_team_id,
        'adds', to_jsonb(tx.adds), 'drops', to_jsonb(tx.drops), 'details', tx.details,
        'created_at', tx.created_at) as j
      from public.hosted_transactions tx
      where tx.division_id = p_division_id
      order by tx.created_at desc, tx.id desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) x), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Hosted leagues: teams
-- -----------------------------------------------------------------------------

create or replace function public.claim_hosted_team(p_team_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid(); v_div uuid; v_owner uuid; c record;
begin
  select t.division_id, t.owner_id into v_div, v_owner from public.hosted_teams t where t.id = p_team_id;
  if not found then raise exception 'That team could not be found.'; end if;
  select * into c from public._ctx(v_div);
  -- Public leagues are open to anyone; private ones need the invite first.
  if not public.can_view_league(c.league_id) then
    raise exception 'Join this league with its invite code before claiming a team.';
  end if;
  perform public._lock_division(v_div);
  select t.owner_id into v_owner from public.hosted_teams t where t.id = p_team_id;
  if v_owner is not null then
    raise exception 'That team already has a manager.';
  end if;
  if exists (select 1 from public.hosted_teams t where t.division_id = v_div and t.owner_id = v_uid) then
    raise exception 'You already manage a team in this division.';
  end if;
  update public.hosted_teams set owner_id = v_uid where id = p_team_id;
  perform public._add_member(c.league_id, v_uid);
end $$;

create or replace function public.rename_hosted_team(p_team_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v text := trim(coalesce(p_name, ''));
begin
  perform public._assert_team_control(p_team_id);
  if char_length(v) < 1 or char_length(v) > 40 then
    raise exception 'Team names must be between 1 and 40 characters.';
  end if;
  update public.hosted_teams set name = v where id = p_team_id;
end $$;

-- A manager can leave their own team; a commissioner can remove anyone.
create or replace function public.release_hosted_team(p_team_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._assert_team_control(p_team_id);
  update public.hosted_teams set owner_id = null where id = p_team_id;
end $$;

-- -----------------------------------------------------------------------------
-- Hosted leagues: lineups and rosters
-- -----------------------------------------------------------------------------

create or replace function public.set_hosted_lineup(p_team_id uuid, p_starters text[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_div uuid; v_slots text[]; i int; v_pid text; v_pos text; v_seen text[] := '{}';
begin
  v_div := public._assert_team_control(p_team_id);
  perform public._lock_division(v_div);
  perform public._assert_draft_complete(v_div);
  v_slots := public._starting_slots(v_div);
  if coalesce(cardinality(p_starters), 0) <> cardinality(v_slots) then
    raise exception 'A lineup needs exactly % starting spots.', cardinality(v_slots);
  end if;
  for i in 1..cardinality(v_slots) loop
    v_pid := coalesce(p_starters[i], '');
    continue when v_pid = '';
    if v_pid = any(v_seen) then
      raise exception 'A player can only fill one lineup spot.';
    end if;
    v_seen := v_seen || v_pid;
    select r.position into v_pos from public.hosted_rosters r where r.team_id = p_team_id and r.player_id = v_pid;
    if not found then
      raise exception 'You can only start players who are on your roster.';
    end if;
    if not public._slot_eligible(v_slots[i], v_pos) then
      raise exception 'A % can''t fill a % spot.', v_pos, v_slots[i];
    end if;
  end loop;
  insert into public.hosted_lineups(team_id, starters)
  values (p_team_id, array(select coalesce(u.x, '') from unnest(p_starters) with ordinality as u(x, o) order by u.o));
end $$;

create or replace function public.hosted_add_player(
  p_team_id uuid, p_add text, p_add_position text default null, p_drop text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_div uuid; v_size int; v_max int;
begin
  v_div := public._assert_team_control(p_team_id);
  perform public._lock_division(v_div);
  perform public._assert_draft_complete(v_div);
  if not public._valid_player_id(p_add) or not public._valid_position(p_add_position) then
    raise exception 'Unknown player.';
  end if;
  if exists (select 1 from public.hosted_rosters r where r.division_id = v_div and r.player_id = p_add) then
    raise exception 'That player is already on a roster.';
  end if;
  if exists (select 1 from public.hosted_waiver_locks w where w.division_id = v_div and w.player_id = p_add and w.clears_at > now()) then
    raise exception 'That player is on waivers. Put in a waiver claim instead.';
  end if;
  if p_drop is not null and not exists (select 1 from public.hosted_rosters r where r.team_id = p_team_id and r.player_id = p_drop) then
    raise exception 'The player you chose to drop isn''t on your roster.';
  end if;
  select count(*) into v_size from public.hosted_rosters r where r.team_id = p_team_id;
  v_max := public._max_roster(v_div);
  if v_size - (case when p_drop is null then 0 else 1 end) + 1 > v_max then
    raise exception 'Your roster is full (% players). Choose someone to drop.', v_max;
  end if;

  if p_drop is not null then
    delete from public.hosted_rosters r where r.team_id = p_team_id and r.player_id = p_drop;
    perform public._remove_from_lineup(p_team_id, p_drop);
    perform public._lock_waiver(v_div, p_drop);
  end if;
  insert into public.hosted_rosters(division_id, player_id, team_id, position, acquired_via)
  values (v_div, p_add, p_team_id, p_add_position, 'free_agent');
  perform public._log(v_div, 'add', p_team_id, null, array[p_add],
    case when p_drop is null then '{}'::text[] else array[p_drop] end, null);
end $$;

create or replace function public.hosted_drop_player(p_team_id uuid, p_player text) returns void
language plpgsql security definer set search_path = public as $$
declare v_div uuid;
begin
  v_div := public._assert_team_control(p_team_id);
  perform public._lock_division(v_div);
  perform public._assert_draft_complete(v_div);
  if not exists (select 1 from public.hosted_rosters r where r.team_id = p_team_id and r.player_id = p_player) then
    raise exception 'That player isn''t on this roster.';
  end if;
  delete from public.hosted_rosters r where r.team_id = p_team_id and r.player_id = p_player;
  perform public._remove_from_lineup(p_team_id, p_player);
  perform public._lock_waiver(v_div, p_player);
  perform public._log(v_div, 'drop', p_team_id, null, '{}', array[p_player], null);
end $$;

-- -----------------------------------------------------------------------------
-- Hosted leagues: waivers
-- -----------------------------------------------------------------------------

create or replace function public.hosted_submit_claim(
  p_team_id uuid, p_add text, p_add_position text default null, p_drop text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_div uuid; v_id bigint;
begin
  v_div := public._assert_team_control(p_team_id);
  perform public._lock_division(v_div);
  perform public._assert_draft_complete(v_div);
  if not public._valid_player_id(p_add) or not public._valid_position(p_add_position) then
    raise exception 'Unknown player.';
  end if;
  if exists (select 1 from public.hosted_rosters r where r.division_id = v_div and r.player_id = p_add) then
    raise exception 'That player is already on a roster.';
  end if;
  if not exists (select 1 from public.hosted_waiver_locks w where w.division_id = v_div and w.player_id = p_add and w.clears_at > now()) then
    raise exception 'That player isn''t on waivers — you can add him right away.';
  end if;
  if p_drop is not null and not exists (select 1 from public.hosted_rosters r where r.team_id = p_team_id and r.player_id = p_drop) then
    raise exception 'The player you chose to drop isn''t on your roster.';
  end if;
  if exists (select 1 from public.hosted_waiver_claims c
             where c.team_id = p_team_id and c.status = 'pending' and c.add_player = p_add
               and c.drop_player is not distinct from p_drop) then
    raise exception 'You already have that claim in.';
  end if;
  if (select count(*) from public.hosted_waiver_claims c where c.team_id = p_team_id and c.status = 'pending') >= 25 then
    raise exception 'You can have at most 25 pending claims.';
  end if;
  insert into public.hosted_waiver_claims(division_id, team_id, add_player, add_position, drop_player)
  values (v_div, p_team_id, p_add, p_add_position, p_drop)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.hosted_cancel_claim(p_claim_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_team uuid; v_status text;
begin
  select c.team_id, c.status into v_team, v_status from public.hosted_waiver_claims c where c.id = p_claim_id;
  if not found then raise exception 'That claim could not be found.'; end if;
  perform public._assert_team_control(v_team);
  if v_status <> 'pending' then raise exception 'Only pending claims can be cancelled.'; end if;
  update public.hosted_waiver_claims set status = 'cancelled', processed_at = now() where id = p_claim_id;
end $$;

-- -----------------------------------------------------------------------------
-- Hosted leagues: trades
-- -----------------------------------------------------------------------------

create or replace function public.hosted_propose_trade(
  p_from_team uuid, p_to_team uuid, p_give text[], p_receive text[], p_message text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid(); v_div uuid; v_div2 uuid; v_owner uuid; x text; v_id bigint;
begin
  select t.division_id, t.owner_id into v_div, v_owner from public.hosted_teams t where t.id = p_from_team;
  if not found then raise exception 'That team could not be found.'; end if;
  if v_owner is distinct from v_uid then
    raise exception 'You can only propose trades from your own team.';
  end if;
  select t.division_id into v_div2 from public.hosted_teams t where t.id = p_to_team;
  if not found or v_div2 <> v_div or p_to_team = p_from_team then
    raise exception 'Choose another team in your division to trade with.';
  end if;
  perform public._lock_division(v_div);
  perform public._assert_draft_complete(v_div);

  p_give := coalesce(p_give, '{}');
  p_receive := coalesce(p_receive, '{}');
  if cardinality(p_give) + cardinality(p_receive) = 0 then
    raise exception 'Add at least one player to the trade.';
  end if;
  if cardinality(p_give) > 15 or cardinality(p_receive) > 15 then
    raise exception 'That trade has too many players.';
  end if;
  if (select count(distinct y) from unnest(p_give || p_receive) y) <> cardinality(p_give) + cardinality(p_receive) then
    raise exception 'Each player can only appear once in a trade.';
  end if;
  foreach x in array p_give loop
    if not exists (select 1 from public.hosted_rosters r where r.team_id = p_from_team and r.player_id = x) then
      raise exception 'You no longer have one of the players you''re offering.';
    end if;
  end loop;
  foreach x in array p_receive loop
    if not exists (select 1 from public.hosted_rosters r where r.team_id = p_to_team and r.player_id = x) then
      raise exception 'One of the players you asked for is no longer on their roster.';
    end if;
  end loop;

  insert into public.hosted_trades(division_id, from_team, to_team, give, receive, message)
  values (v_div, p_from_team, p_to_team, p_give, p_receive, nullif(left(trim(coalesce(p_message, '')), 280), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.hosted_respond_trade(p_trade_id bigint, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public._require_uid();
  t record; v_div uuid; v_to_owner uuid; v_max int; v_from_size int; v_to_size int; x text; v_err text;
begin
  select tr.division_id into v_div from public.hosted_trades tr where tr.id = p_trade_id;
  if not found then raise exception 'That trade could not be found.'; end if;
  perform public._lock_division(v_div);

  select * into t from public.hosted_trades tr where tr.id = p_trade_id;
  if t.status <> 'pending' then
    raise exception 'This trade has already been resolved.';
  end if;
  select tm.owner_id into v_to_owner from public.hosted_teams tm where tm.id = t.to_team;

  if not p_accept then
    if v_to_owner is distinct from v_uid and not public._is_commish(t.division_id) then
      raise exception 'Only the team receiving this offer can decline it.';
    end if;
    update public.hosted_trades
    set status = 'rejected', resolved_at = now(),
        note = case when v_to_owner is distinct from v_uid then 'Vetoed by the commissioner.' end
    where id = p_trade_id;
    return jsonb_build_object('status', 'rejected');
  end if;

  if v_to_owner is distinct from v_uid then
    raise exception 'Only the team receiving this offer can accept it.';
  end if;

  foreach x in array t.give loop
    if not exists (select 1 from public.hosted_rosters r where r.team_id = t.from_team and r.player_id = x) then
      v_err := 'A player in this trade is no longer on the offering team.';
    end if;
  end loop;
  foreach x in array t.receive loop
    if not exists (select 1 from public.hosted_rosters r where r.team_id = t.to_team and r.player_id = x) then
      v_err := 'A player in this trade is no longer on your roster.';
    end if;
  end loop;
  if v_err is not null then
    update public.hosted_trades set status = 'failed', note = v_err, resolved_at = now() where id = p_trade_id;
    return jsonb_build_object('status', 'failed', 'note', v_err);
  end if;

  -- Roster limits are fixable (someone drops a player), so the offer stays
  -- open rather than being marked failed.
  v_max := public._max_roster(t.division_id);
  select count(*) into v_from_size from public.hosted_rosters r where r.team_id = t.from_team;
  select count(*) into v_to_size   from public.hosted_rosters r where r.team_id = t.to_team;
  if v_to_size - cardinality(t.receive) + cardinality(t.give) > v_max then
    raise exception 'This trade would put you over the % player roster limit. Drop someone first, then accept.', v_max;
  end if;
  if v_from_size - cardinality(t.give) + cardinality(t.receive) > v_max then
    raise exception 'This trade would put the other team over the roster limit. They need to drop a player first.';
  end if;

  foreach x in array t.give loop
    update public.hosted_rosters set team_id = t.to_team, acquired_via = 'trade', acquired_at = now()
    where division_id = t.division_id and player_id = x;
    perform public._remove_from_lineup(t.from_team, x);
  end loop;
  foreach x in array t.receive loop
    update public.hosted_rosters set team_id = t.from_team, acquired_via = 'trade', acquired_at = now()
    where division_id = t.division_id and player_id = x;
    perform public._remove_from_lineup(t.to_team, x);
  end loop;

  update public.hosted_trades set status = 'accepted', resolved_at = now() where id = p_trade_id;
  update public.hosted_trades
  set status = 'failed', note = 'Some of these players were traded elsewhere.', resolved_at = now()
  where division_id = t.division_id and status = 'pending' and id <> p_trade_id
    and (give && (t.give || t.receive) or receive && (t.give || t.receive));

  perform public._log(t.division_id, 'trade', t.from_team, t.to_team, t.receive, t.give,
                      jsonb_build_object('trade_id', p_trade_id));
  return jsonb_build_object('status', 'accepted');
end $$;

create or replace function public.hosted_cancel_trade(p_trade_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public._require_uid(); v_from uuid; v_status text; v_owner uuid;
begin
  select tr.from_team, tr.status into v_from, v_status from public.hosted_trades tr where tr.id = p_trade_id;
  if not found then raise exception 'That trade could not be found.'; end if;
  select t.owner_id into v_owner from public.hosted_teams t where t.id = v_from;
  if v_owner is distinct from v_uid then
    raise exception 'Only the team that proposed this trade can cancel it.';
  end if;
  if v_status <> 'pending' then
    raise exception 'Only pending trades can be cancelled.';
  end if;
  update public.hosted_trades set status = 'cancelled', resolved_at = now() where id = p_trade_id;
end $$;

-- -----------------------------------------------------------------------------
-- Hosted leagues: the draft
-- -----------------------------------------------------------------------------

create or replace function public.hosted_draft_set_order(p_division_id uuid, p_team_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._ctx(p_division_id);
  perform public._assert_commish(p_division_id);
  perform public._lock_division(p_division_id);
  if not exists (select 1 from public.hosted_drafts d where d.division_id = p_division_id and d.status = 'scheduled') then
    raise exception 'The draft order can only change before the draft starts.';
  end if;
  if coalesce(cardinality(p_team_ids), 0) <> (select count(*) from public.hosted_teams t where t.division_id = p_division_id)
     or (select count(distinct x) from unnest(p_team_ids) x) <> cardinality(p_team_ids)
     or exists (select 1 from unnest(p_team_ids) x
                where not exists (select 1 from public.hosted_teams t where t.id = x and t.division_id = p_division_id)) then
    raise exception 'The draft order must list every team in the division exactly once.';
  end if;
  update public.hosted_drafts set order_team_ids = p_team_ids where division_id = p_division_id;
end $$;

create or replace function public.hosted_draft_randomize(p_division_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._ctx(p_division_id);
  perform public._assert_commish(p_division_id);
  perform public._lock_division(p_division_id);
  if not exists (select 1 from public.hosted_drafts d where d.division_id = p_division_id and d.status = 'scheduled') then
    raise exception 'The draft order can only change before the draft starts.';
  end if;
  update public.hosted_drafts
  set order_team_ids = array(select t.id from public.hosted_teams t where t.division_id = p_division_id order by random())
  where division_id = p_division_id;
end $$;

create or replace function public.hosted_draft_start(p_division_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._ctx(p_division_id);
  perform public._assert_commish(p_division_id);
  perform public._lock_division(p_division_id);
  if not exists (select 1 from public.hosted_drafts d where d.division_id = p_division_id and d.status = 'scheduled') then
    raise exception 'The draft has already started.';
  end if;
  update public.hosted_drafts
  set status = 'drafting', started_at = now(), current_pick_started_at = now()
  where division_id = p_division_id;
end $$;

-- p_autopick lets any manager in the division make the pick for a team whose
-- clock has run out, so one absent manager can't stall everyone. The browser
-- chooses the best available player; made_by records who triggered it.
create or replace function public.hosted_draft_pick(
  p_division_id uuid, p_player_id text, p_position text default null, p_autopick boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public._require_uid();
  d record; v_pick int; v_total int; v_team uuid; v_owner uuid; v_allowed boolean; v_n int;
begin
  perform public._ctx(p_division_id);
  perform public._lock_division(p_division_id);
  select * into d from public.hosted_drafts x where x.division_id = p_division_id;
  if not found or d.status <> 'drafting' then
    raise exception 'The draft isn''t running.';
  end if;
  if not public._valid_player_id(p_player_id) or not public._valid_position(p_position) then
    raise exception 'Unknown player.';
  end if;

  v_n := cardinality(d.order_team_ids);
  select count(*) + 1 into v_pick from public.hosted_draft_picks pk where pk.division_id = p_division_id;
  v_total := d.rounds * v_n;
  v_team := public._draft_team_for_pick(p_division_id, v_pick);
  select t.owner_id into v_owner from public.hosted_teams t where t.id = v_team;

  v_allowed := v_owner = v_uid or public._is_commish(p_division_id);
  if not v_allowed and p_autopick then
    v_allowed := now() > d.current_pick_started_at + make_interval(secs => d.pick_seconds)
      and exists (select 1 from public.hosted_teams t where t.division_id = p_division_id and t.owner_id = v_uid);
  end if;
  if not v_allowed then
    raise exception 'It isn''t your pick.';
  end if;
  if exists (select 1 from public.hosted_rosters r where r.division_id = p_division_id and r.player_id = p_player_id) then
    raise exception 'That player has already been drafted.';
  end if;

  insert into public.hosted_draft_picks(division_id, pick_no, round, team_id, player_id, made_by)
  values (p_division_id, v_pick, ((v_pick - 1) / v_n) + 1, v_team, p_player_id, v_uid);
  insert into public.hosted_rosters(division_id, player_id, team_id, position, acquired_via)
  values (p_division_id, p_player_id, v_team, p_position, 'draft');

  if v_pick >= v_total then
    update public.hosted_drafts
    set status = 'complete', completed_at = now(), current_pick_started_at = null
    where division_id = p_division_id;
    -- Waiver priority starts in reverse of the first-round order.
    update public.hosted_teams t
    set waiver_priority = v_n - array_position(d.order_team_ids, t.id) + 1
    where t.division_id = p_division_id;
    perform public._autofill_lineups(p_division_id);
    perform public._log(p_division_id, 'draft', null, null, '{}', '{}', jsonb_build_object('picks', v_total));
  else
    update public.hosted_drafts set current_pick_started_at = now() where division_id = p_division_id;
  end if;

  return jsonb_build_object('pick_no', v_pick, 'team_id', v_team, 'complete', v_pick >= v_total);
end $$;

create or replace function public.hosted_draft_undo(p_division_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_last record;
begin
  perform public._ctx(p_division_id);
  perform public._assert_commish(p_division_id);
  perform public._lock_division(p_division_id);
  if not exists (select 1 from public.hosted_drafts d where d.division_id = p_division_id and d.status = 'drafting') then
    raise exception 'Picks can only be undone while the draft is running.';
  end if;
  select pk.pick_no, pk.player_id into v_last from public.hosted_draft_picks pk
  where pk.division_id = p_division_id order by pk.pick_no desc limit 1;
  if not found then
    raise exception 'No picks have been made yet.';
  end if;
  delete from public.hosted_draft_picks pk where pk.division_id = p_division_id and pk.pick_no = v_last.pick_no;
  delete from public.hosted_rosters r where r.division_id = p_division_id and r.player_id = v_last.player_id;
  update public.hosted_drafts set current_pick_started_at = now() where division_id = p_division_id;
end $$;

-- -----------------------------------------------------------------------------
-- Hosted leagues: commissioner settings
-- -----------------------------------------------------------------------------

create or replace function public.hosted_update_settings(p_division_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_started boolean; v_start int; v_weeks int;
begin
  perform public._ctx(p_division_id);
  perform public._assert_commish(p_division_id);
  perform public._lock_division(p_division_id);

  if p ? 'waiver_hours' then
    if (p->>'waiver_hours')::int not between 0 and 168 then
      raise exception 'The waiver period must be between 0 and 168 hours.';
    end if;
    update public.hosted_settings set waiver_hours = (p->>'waiver_hours')::int where division_id = p_division_id;
  end if;

  if p ? 'pick_seconds' then
    if (p->>'pick_seconds')::int not between 15 and 86400 then
      raise exception 'The pick timer must be between 15 seconds and 24 hours.';
    end if;
    update public.hosted_drafts set pick_seconds = (p->>'pick_seconds')::int where division_id = p_division_id;
  end if;

  if p ? 'start_week' or p ? 'regular_season_weeks' then
    select d.status <> 'scheduled' into v_started from public.hosted_drafts d where d.division_id = p_division_id;
    if v_started then
      raise exception 'The season schedule is locked once the draft starts.';
    end if;
    select coalesce((p->>'start_week')::int, s.start_week), coalesce((p->>'regular_season_weeks')::int, s.regular_season_weeks)
      into v_start, v_weeks
    from public.hosted_settings s where s.division_id = p_division_id;
    if v_start < 1 or v_weeks < 1 or v_start + v_weeks - 1 > 18 then
      raise exception 'The regular season has to fit inside NFL weeks 1–18.';
    end if;
    update public.hosted_settings set start_week = v_start, regular_season_weeks = v_weeks where division_id = p_division_id;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Row Level Security and privileges (old policies were cleared near the top)
-- -----------------------------------------------------------------------------

alter table public.leagues              enable row level security;
alter table public.divisions            enable row level security;
alter table public.espn_credentials     enable row level security;
alter table public.league_members       enable row level security;
alter table public.profiles             enable row level security;
alter table public.hosted_settings      enable row level security;
alter table public.hosted_teams         enable row level security;
alter table public.hosted_rosters       enable row level security;
alter table public.hosted_lineups       enable row level security;
alter table public.hosted_drafts        enable row level security;
alter table public.hosted_draft_picks   enable row level security;
alter table public.hosted_waiver_locks  enable row level security;
alter table public.hosted_waiver_claims enable row level security;
alter table public.hosted_trades        enable row level security;
alter table public.hosted_transactions  enable row level security;

revoke all on public.leagues, public.divisions, public.espn_credentials, public.league_members, public.profiles,
              public.hosted_settings, public.hosted_teams, public.hosted_rosters, public.hosted_lineups,
              public.hosted_drafts, public.hosted_draft_picks, public.hosted_waiver_locks,
              public.hosted_waiver_claims, public.hosted_trades, public.hosted_transactions
  from anon, authenticated;

-- Only these columns are readable directly. Everything else — invite codes,
-- commissioner email, ESPN cookies, and all hosted-league tables — is reachable
-- only through the functions above, which apply their own checks.
grant select (id, name, slug, commissioner_id, num_divisions, playoff_length_weeks, playoff_advance_count,
              is_public, finalized, created_at, sport, format, hosting)
  on public.leagues to anon, authenticated;
grant select (id, league_id, name, platform, external_league_id, sort_order, commissioner_id, created_at)
  on public.divisions to anon, authenticated;
grant select (id, league_id, user_id, joined_at)
  on public.league_members to authenticated;

create policy leagues_visible on public.leagues
  for select using (is_public or public.is_league_member(id));
create policy divisions_visible on public.divisions
  for select using (public.can_view_league(league_id));
create policy league_members_own on public.league_members
  for select using (user_id = auth.uid());

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in (
        '_require_uid','_slugify','_random_code','_random_digits6','_add_member','_ctx','_is_commish',
        '_lock_division','_assert_commish','_assert_team_control','_max_roster','_starting_slots',
        '_assert_draft_complete','_valid_player_id','_valid_position','_slot_eligible','_remove_from_lineup',
        '_lock_waiver','_log','_draft_team_for_pick','_autofill_lineups','_process_waivers',
        'is_league_member','can_view_league','set_display_name','get_my_profile','create_league',
        'join_league_by_code','get_league_admin','update_league_settings','set_league_finalized',
        'create_division_commish_invite','remove_division_commissioner','claim_division_commissioner',
        'hosted_division_state','hosted_lineup_history','hosted_transactions_list','claim_hosted_team',
        'rename_hosted_team','release_hosted_team','set_hosted_lineup','hosted_add_player','hosted_drop_player',
        'hosted_submit_claim','hosted_cancel_claim','hosted_propose_trade','hosted_respond_trade',
        'hosted_cancel_trade','hosted_draft_set_order','hosted_draft_randomize','hosted_draft_start',
        'hosted_draft_pick','hosted_draft_undo','hosted_update_settings')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if left(f.proname, 1) <> '_' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

commit;
