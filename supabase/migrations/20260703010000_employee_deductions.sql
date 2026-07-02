create table if not exists public.employee_deductions (
  id uuid primary key default gen_random_uuid(),
  branch_id text not null,
  employee_id uuid not null references public.employees(id),
  deduction_date date not null,
  deduction_type text not null default 'manual_deduction'
    check (deduction_type in ('damage', 'advance', 'manual_deduction', 'other')),
  amount numeric not null default 0 check (amount >= 0),
  reason text,
  notes text,
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by uuid references public.profiles(id),
  voided_by uuid references public.profiles(id),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_deductions_branch_date_idx
  on public.employee_deductions(branch_id, deduction_date desc);

create index if not exists employee_deductions_employee_date_idx
  on public.employee_deductions(employee_id, deduction_date desc);

grant select, insert, update, delete on public.employee_deductions to authenticated;
grant select, insert, update, delete on public.employee_deductions to service_role;
