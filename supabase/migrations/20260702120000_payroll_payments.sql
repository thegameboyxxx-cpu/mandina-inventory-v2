create table if not exists public.payroll_payments (
  id uuid primary key default gen_random_uuid(),
  branch_id text not null,
  employee_id uuid not null references public.employees(id),
  payroll_period_id uuid references public.payroll_periods(id) on delete set null,
  payroll_line_id uuid references public.payroll_lines(id) on delete set null,
  period_start date not null,
  period_end date not null,
  gross_pay numeric(12,2) not null default 0,
  deductions numeric(12,2) not null default 0,
  net_pay numeric(12,2) not null default 0,
  payment_amount numeric(12,2) not null default 0,
  payment_method text not null default 'cash',
  payment_reference text,
  cash_balance_before numeric(12,2),
  cash_balance_after numeric(12,2),
  notes text,
  status text not null default 'paid',
  paid_by uuid references public.profiles(id),
  paid_at timestamptz not null default now(),
  voided_by uuid references public.profiles(id),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payroll_payments_method_check check (payment_method in ('cash','bank','card','other')),
  constraint payroll_payments_status_check check (status in ('paid','voided'))
);

create index if not exists payroll_payments_branch_period_idx
  on public.payroll_payments(branch_id, period_start, period_end);

create index if not exists payroll_payments_employee_idx
  on public.payroll_payments(employee_id);

grant select, insert, update, delete on public.payroll_payments to authenticated;
grant select, insert, update, delete on public.payroll_payments to service_role;
