-- RentaManager — Schema completo
-- Ejecuta esto en Supabase → SQL Editor

-- ─────────────────────────────────────────────
-- TABLAS
-- ─────────────────────────────────────────────

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

-- Tabla para compartir propiedades con otros usuarios
create table if not exists property_members (
  id uuid default gen_random_uuid() primary key,
  property_id uuid references properties(id) on delete cascade,
  user_email text not null,
  role text check (role in ('editor','viewer')) default 'viewer',
  invited_by uuid references auth.users,
  created_at timestamptz default now(),
  unique(property_id, user_email)
);

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────

alter table properties enable row level security;
alter table transactions enable row level security;
alter table property_members enable row level security;

-- PROPERTIES: lectura para propietarios y miembros
create policy "props_read" on properties
  for select using (
    auth.uid() = owner_id
    or exists (
      select 1 from property_members pm
      where pm.property_id = id
        and pm.user_email = (auth.jwt() ->> 'email')
    )
  );

create policy "props_insert" on properties
  for insert with check (auth.uid() = owner_id);

create policy "props_update" on properties
  for update using (
    auth.uid() = owner_id
    or exists (
      select 1 from property_members pm
      where pm.property_id = id
        and pm.user_email = (auth.jwt() ->> 'email')
        and pm.role = 'editor'
    )
  );

create policy "props_delete" on properties
  for delete using (auth.uid() = owner_id);

-- TRANSACTIONS: acceso si el usuario tiene acceso a la propiedad
create policy "txns_access" on transactions
  for all using (
    exists (
      select 1 from properties p
      where p.id = property_id and (
        p.owner_id = auth.uid()
        or exists (
          select 1 from property_members pm
          where pm.property_id = p.id
            and pm.user_email = (auth.jwt() ->> 'email')
        )
      )
    )
  );

-- PROPERTY_MEMBERS: propietarios gestionan, miembros ven los suyos
create policy "members_owner_manage" on property_members
  for all using (
    exists (
      select 1 from properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );

create policy "members_see_own" on property_members
  for select using (
    user_email = (auth.jwt() ->> 'email')
  );
