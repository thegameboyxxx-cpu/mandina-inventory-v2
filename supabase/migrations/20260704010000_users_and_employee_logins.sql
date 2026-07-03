alter table public.profiles
  add column if not exists email text,
  add column if not exists login_type text not null default 'google',
  add column if not exists employee_id uuid references public.employees(id),
  add column if not exists employee_number text,
  add column if not exists branch_id text,
  add column if not exists active boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists profiles_employee_id_key
  on public.profiles(employee_id)
  where employee_id is not null;

create unique index if not exists profiles_employee_number_key
  on public.profiles(employee_number)
  where employee_number is not null;

create table if not exists public.user_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text,
  role text not null default 'manager',
  login_type text not null default 'google',
  employee_id uuid references public.employees(id),
  branch_id text,
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_invites_role_check check (role in ('manager', 'staff')),
  constraint user_invites_login_type_check check (login_type in ('google', 'employee_number'))
);

create unique index if not exists user_invites_email_active_key
  on public.user_invites(lower(email))
  where active = true;

alter table public.user_invites enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_invites'
      and policyname = 'Managers can manage user invites'
  ) then
    create policy "Managers can manage user invites"
      on public.user_invites
      for all
      to authenticated
      using (
        exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and p.role = 'manager'
            and coalesce(p.active, true) = true
        )
      )
      with check (
        exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and p.role = 'manager'
            and coalesce(p.active, true) = true
        )
      );
  end if;
end $$;

grant select, insert, update, delete on public.user_invites to authenticated;
grant select, insert, update, delete on public.user_invites to service_role;
