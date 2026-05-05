-- RentaManager — Schema
-- Ejecuta esto en Supabase → SQL Editor

create table if not exists properties (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users not null,
  name text not null,
  location text,
  type text check (type in ('long-term','short-term')) default 'long-term',
  currency text default 'EUR',
  color text default '#c9956e',
  sqm numeric,
  notes text,
  created_at timestamptz default now()
);

create table if not exists transactions (
  id uuid default gen_random_uuid() primary key,
  property_id uuid references properties(id) on delete cascade,
  type text check (type in ('income','expense')) not null,
  category text,
  amount numeric not null default 0,
  currency text default 'EUR',
  date date not null default current_date,
  description text,
  platform text,
  check_in date,
  check_out date,
  payment_status text check (payment_status in ('paid','pending','overdue')) default 'paid',
  notes text,
  created_at timestamptz default now()
);

alter table properties enable row level security;
alter table transactions enable row level security;

-- Each user only sees their own properties
create policy "owners_props" on properties
  for all using (auth.uid() = owner_id);

-- Transactions are accessible if the user owns the linked property
create policy "txns_via_props" on transactions
  for all using (
    exists (
      select 1 from properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );
