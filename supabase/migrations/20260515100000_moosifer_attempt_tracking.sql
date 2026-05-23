create table if not exists public.moosifer_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id text unique,
  wallet_address text references public.players(wallet_address) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome text not null default 'started',
  wave_reached integer,
  moosifer_difficulty integer,
  moosifer_hp_remaining numeric(20,8),
  moosifer_max_hp numeric(20,8),
  portal_hp_remaining numeric(20,8),
  portal_max_hp numeric(20,8),
  moosifer_phase text,
  source text not null default 'client',
  details jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint moosifer_attempts_wallet_lowercase check (wallet_address is null or wallet_address = lower(wallet_address)),
  constraint moosifer_attempts_outcome_check check (outcome in ('started', 'failed', 'defeated', 'abandoned', 'disconnected'))
);

create index if not exists idx_moosifer_attempts_wallet_started on public.moosifer_attempts (wallet_address, started_at desc);
create index if not exists idx_moosifer_attempts_outcome_started on public.moosifer_attempts (outcome, started_at desc);

alter table public.moosifer_attempts enable row level security;

drop trigger if exists trg_moosifer_attempts_updated_at on public.moosifer_attempts;
create trigger trg_moosifer_attempts_updated_at
before update on public.moosifer_attempts
for each row execute function public.set_updated_at();

drop policy if exists "moosifer_attempts_read_none" on public.moosifer_attempts;
create policy "moosifer_attempts_read_none"
  on public.moosifer_attempts
  for all
  to anon, authenticated
  using (false)
  with check (false);
