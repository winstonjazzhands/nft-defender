create table if not exists public.hero_shop_purchases (
  id uuid primary key default gen_random_uuid(),
  buyer_wallet text not null,
  shop_wallet text not null,
  hero_id text not null,
  chain_id integer not null default 53935,
  chain_name text not null default 'dfk',
  class_name text,
  rarity_name text,
  level integer,
  payment_currency text not null,
  payment_asset text not null,
  expected_amount_wei numeric not null,
  payment_session_id uuid,
  tx_hash text,
  status text not null default 'paid',
  fulfilled_at timestamptz,
  fulfilled_tx_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hero_shop_purchases_status_check check (status in ('paid', 'fulfilled', 'refunded', 'cancelled')),
  constraint hero_shop_purchases_currency_check check (payment_currency in ('RON', 'JEWEL', 'AVAX'))
);

create index if not exists hero_shop_purchases_buyer_idx on public.hero_shop_purchases (buyer_wallet, created_at desc);
create index if not exists hero_shop_purchases_status_idx on public.hero_shop_purchases (status, created_at desc);
create unique index if not exists hero_shop_purchases_tx_hash_idx on public.hero_shop_purchases (tx_hash);

alter table public.hero_shop_purchases enable row level security;

drop policy if exists "hero_shop_purchases_read_none" on public.hero_shop_purchases;
create policy "hero_shop_purchases_read_none"
  on public.hero_shop_purchases
  for select
  using (false);
