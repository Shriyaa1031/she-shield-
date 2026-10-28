-- Run this in Supabase: SQL Editor -> New query -> Run

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  phone text not null,
  relation text,
  created_at timestamptz not null default now()
);

create table if not exists public.sos_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','resolved')),
  lat double precision,
  lng double precision,
  accuracy double precision,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.sos_locations (
  id bigint generated always as identity primary key,
  alert_id uuid not null references public.sos_alerts(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  created_at timestamptz not null default now()
);

create index if not exists sos_alerts_user_idx on public.sos_alerts(user_id, created_at desc);
create index if not exists sos_locations_alert_idx on public.sos_locations(alert_id, created_at desc);

-- Row Level Security: each user can only see and change their own rows
alter table public.contacts enable row level security;
alter table public.sos_alerts enable row level security;
alter table public.sos_locations enable row level security;

create policy "contacts_own" on public.contacts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "alerts_own" on public.sos_alerts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "locations_own" on public.sos_locations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
