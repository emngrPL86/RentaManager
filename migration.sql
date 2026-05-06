-- ================================================================
-- RentaManager — Migración
-- ================================================================
-- Ejecuta esto si ya tienes las tablas properties y transactions.
-- Es seguro correrlo múltiples veces (usa IF NOT EXISTS).
-- ================================================================

create table if not exists property_members (
  id           uuid        default gen_random_uuid() primary key,
  property_id  uuid        references properties(id) on delete cascade,
  user_email   text        not null,
  role         text        check (role in ('editor','viewer')) default 'viewer',
  invited_by   uuid        references auth.users,
  created_at   timestamptz default now(),
  unique(property_id, user_email)
);

alter table property_members enable row level security;

create policy "members_owner_manage" on property_members
  for all using (
    exists (
      select 1 from properties p
      where p.id = property_id
        and p.owner_id = auth.uid()
    )
  );

create policy "members_see_own" on property_members
  for select using (
    user_email = (auth.jwt() ->> 'email')
  );
