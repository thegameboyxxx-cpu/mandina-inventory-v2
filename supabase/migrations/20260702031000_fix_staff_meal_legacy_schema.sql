alter table public.staff_meals
  add column if not exists staff_meal_number text,
  add column if not exists employee_id uuid references public.employees(id),
  add column if not exists shift_id uuid references public.shift_schedules(id),
  add column if not exists status text not null default 'submitted',
  add column if not exists total_estimated_cost numeric(12,2) not null default 0,
  add column if not exists allowance_used boolean not null default false,
  add column if not exists requested_by uuid references public.profiles(id),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists rejected_by uuid references public.profiles(id),
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.staff_meals
  alter column user_id drop not null,
  alter column total_menu_value drop not null,
  alter column discountable_amount drop not null,
  alter column discount_amount drop not null,
  alter column full_price_remainder drop not null,
  alter column employee_charge drop not null;

create unique index if not exists staff_meals_staff_meal_number_key
  on public.staff_meals(staff_meal_number)
  where staff_meal_number is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'staff_meals_status_check'
      and conrelid = 'public.staff_meals'::regclass
  ) then
    alter table public.staff_meals
      add constraint staff_meals_status_check
      check (status in ('submitted','approved','rejected','cancelled'));
  end if;
end $$;

alter table public.staff_meal_lines
  add column if not exists item_name text,
  add column if not exists estimated_cost numeric(12,2) not null default 0,
  add column if not exists notes text,
  add column if not exists created_at timestamptz not null default now();

alter table public.staff_meal_lines
  alter column unit_price drop not null;
