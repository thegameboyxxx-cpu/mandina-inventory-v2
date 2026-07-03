alter table public.payroll_payments
  add column if not exists voided_by uuid references public.profiles(id),
  add column if not exists voided_at timestamptz;
