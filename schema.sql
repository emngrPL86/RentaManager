-- ================================================================
-- RentaManager — Schema completo
-- ================================================================
-- Este archivo es la referencia completa de la base de datos.
-- Para una instalación nueva: ejecuta todo de arriba a abajo.
-- Para actualizar una instalación existente: usa migration.sql
-- ================================================================

-- ----------------------------------------------------------------
-- TABLAS
-- ----------------------------------------------------------------

create table if not exists properties (
  id          uuid        default gen_random_uuid() primary key,
  owner_id    uuid        references auth.users not null,
  name        text        not null,
  location    text,
  type        text        check (type in ('long-term','short-term')) default 'long-term',
  currency    text        default 'EUR',
  color       text        default '#c9956e',
  sqm         numeric,
  notes       text,
  created_at  timestamptz default now()
);

create table if not exists transactions (
  id              uuid        default gen_random_uuid() primary key,
  property_id     uuid        references properties(id) on delete cascade,
  type            text        check (type in ('income','expense')) not null,
  category        text,
  amount          numeric     not null default 0,
  currency        text        default 'EUR',
  date            date        not null default current_date,
  description     text,
  platform        text,
  check_in        date,
  check_out       date,
  payment_status  text        check (payment_status in ('paid','pending','overdue')) default 'paid',
  notes           text,
  created_at      timestamptz default now()
);

create table if not exists property_members (
  id           uuid        default gen_random_uuid() primary key,
  property_id  uuid        references properties(id) on delete cascade,
  user_email   text        not null,
  role         text        check (role in ('editor','viewer')) default 'viewer',
  invited_by   uuid        references auth.users,
  created_at   timestamptz default now(),
  unique(property_id, user_email)
);

-- ----------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------

alter table properties       enable row level security;
alter table transactions      enable row level security;
alter table property_members  enable row level security;

-- PROPERTIES: cada usuario ve y gestiona solo las suyas
create policy "owners_props" on properties
  for all using (auth.uid() = owner_id);

-- TRANSACTIONS: acceso si el usuario es dueño de la propiedad
create policy "txns_via_props" on transactions
  for all using (
    exists (
      select 1 from properties p
      where p.id = property_id
        and p.owner_id = auth.uid()
    )
  );

-- PROPERTY_MEMBERS: propietarios gestionan accesos de sus propiedades
create policy "members_owner_manage" on property_members
  for all using (
    exists (
      select 1 from properties p
      where p.id = property_id
        and p.owner_id = auth.uid()
    )
  );

-- PROPERTY_MEMBERS: cada usuario ve las invitaciones a su email
create policy "members_see_own" on property_members
  for select using (
    user_email = (auth.jwt() ->> 'email')
  );
