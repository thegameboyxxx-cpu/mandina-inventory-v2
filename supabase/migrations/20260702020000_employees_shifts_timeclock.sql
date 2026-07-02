create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null unique,
  full_name text not null,
  phone text,
  email text,
  branch_id text not null,
  employment_type text not null default 'casual',
  hourly_rate numeric(10,2) not null default 0,
  active boolean not null default true,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shift_schedules (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  branch_id text not null,
  shift_date date not null,
  start_time time not null,
  end_time time not null,
  role text,
  notes text,
  status text not null default 'planned',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_schedules_status_check check (status in ('planned','cancelled')),
  constraint shift_schedules_time_check check (end_time > start_time)
);

create index if not exists shift_schedules_branch_date_idx
  on public.shift_schedules(branch_id, shift_date);

create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  shift_id uuid references public.shift_schedules(id),
  branch_id text not null,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  clock_in_latitude numeric,
  clock_in_longitude numeric,
  clock_out_latitude numeric,
  clock_out_longitude numeric,
  clock_in_accuracy_meters numeric,
  clock_out_accuracy_meters numeric,
  clock_in_distance_meters numeric,
  clock_out_distance_meters numeric,
  clock_in_reason text,
  clock_out_reason text,
  status text not null default 'clocked_in',
  total_minutes integer not null default 0,
  paid_minutes integer not null default 0,
  break_minutes integer not null default 0,
  notes text,
  manager_edited_by uuid references public.profiles(id),
  manager_edit_reason text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_entries_status_check check (status in ('clocked_in','clocked_out','manager_edited','cancelled'))
);

create index if not exists time_entries_branch_created_idx
  on public.time_entries(branch_id, created_at desc);

create index if not exists time_entries_employee_open_idx
  on public.time_entries(employee_id)
  where status = 'clocked_in';

alter table public.branches
  add column if not exists latitude numeric,
  add column if not exists longitude numeric,
  add column if not exists allowed_radius_meters integer not null default 100,
  add column if not exists timeclock_location_required boolean not null default false,
  add column if not exists timeclock_timing_required boolean not null default false;

grant select, insert, update, delete on public.employees to authenticated;
grant select, insert, update, delete on public.shift_schedules to authenticated;
grant select, insert, update, delete on public.time_entries to authenticated;
grant select, insert, update, delete on public.employees to service_role;
grant select, insert, update, delete on public.shift_schedules to service_role;
grant select, insert, update, delete on public.time_entries to service_role;
