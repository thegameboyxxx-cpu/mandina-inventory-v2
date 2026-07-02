create table if not exists public.staff_meals (
  id uuid primary key default gen_random_uuid(),
  staff_meal_number text not null unique,
  branch_id text not null,
  employee_id uuid not null references public.employees(id),
  meal_date date not null,
  shift_id uuid references public.shift_schedules(id),
  status text not null default 'submitted',
  total_estimated_cost numeric(12,2) not null default 0,
  allowance_used boolean not null default false,
  notes text,
  requested_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  rejected_by uuid references public.profiles(id),
  cancelled_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint staff_meals_status_check check (status in ('submitted','approved','rejected','cancelled'))
);

create table if not exists public.staff_meal_lines (
  id uuid primary key default gen_random_uuid(),
  staff_meal_id uuid not null references public.staff_meals(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id),
  item_name text,
  qty numeric(12,3) not null default 1,
  estimated_cost numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.payroll_periods (
  id uuid primary key default gen_random_uuid(),
  branch_id text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'draft',
  total_hours numeric(12,2) not null default 0,
  total_gross_pay numeric(12,2) not null default 0,
  notes text,
  created_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint payroll_periods_status_check check (status in ('draft','calculated','approved','exported','cancelled'))
);

create table if not exists public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.payroll_periods(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  normal_hours numeric(12,2) not null default 0,
  total_paid_hours numeric(12,2) not null default 0,
  hourly_rate numeric(10,2) not null default 0,
  gross_pay numeric(12,2) not null default 0,
  allowances numeric(12,2) not null default 0,
  deductions numeric(12,2) not null default 0,
  final_gross_pay numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.staff_meals to authenticated;
grant select, insert, update, delete on public.staff_meal_lines to authenticated;
grant select, insert, update, delete on public.payroll_periods to authenticated;
grant select, insert, update, delete on public.payroll_lines to authenticated;
grant select, insert, update, delete on public.staff_meals to service_role;
grant select, insert, update, delete on public.staff_meal_lines to service_role;
grant select, insert, update, delete on public.payroll_periods to service_role;
grant select, insert, update, delete on public.payroll_lines to service_role;
