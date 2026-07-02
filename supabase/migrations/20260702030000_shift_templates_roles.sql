alter table public.employees
  add column if not exists operational_role text not null default 'front_staff';

create table if not exists public.shift_templates (
  id uuid primary key default gen_random_uuid(),
  branch_id text not null,
  name text not null,
  active boolean not null default true,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shift_template_lines (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.shift_templates(id) on delete cascade,
  weekday integer not null,
  employee_id uuid not null references public.employees(id),
  start_time time not null,
  end_time time not null,
  role text,
  notes text,
  created_at timestamptz not null default now(),
  constraint shift_template_lines_weekday_check check (weekday between 1 and 7),
  constraint shift_template_lines_time_check check (end_time > start_time)
);

create index if not exists shift_templates_branch_idx
  on public.shift_templates(branch_id, active);

grant select, insert, update, delete on public.shift_templates to authenticated;
grant select, insert, update, delete on public.shift_template_lines to authenticated;
grant select, insert, update, delete on public.shift_templates to service_role;
grant select, insert, update, delete on public.shift_template_lines to service_role;
