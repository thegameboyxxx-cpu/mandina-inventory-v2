create table if not exists public.cash_register_counts (
  id uuid primary key default gen_random_uuid(),
  branch_id text not null,
  count_date date not null,
  expected_cash numeric(12,2) not null default 0,
  actual_cash numeric(12,2) not null default 0,
  difference numeric(12,2) generated always as (actual_cash - expected_cash) stored,
  reason text,
  notes text,
  status text not null default 'submitted',
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_register_counts_status_check check (status in ('submitted','reviewed','voided')),
  constraint cash_register_counts_difference_reason_check check (
    actual_cash = expected_cash or nullif(trim(coalesce(reason, '')), '') is not null
  )
);

create unique index if not exists cash_register_counts_branch_date_key
  on public.cash_register_counts(branch_id, count_date);

grant select, insert, update, delete on public.cash_register_counts to authenticated;
grant select, insert, update, delete on public.cash_register_counts to service_role;

insert into storage.buckets (id, name, public)
values ('waste-photos', 'waste-photos', true)
on conflict (id) do update set public = excluded.public;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Authenticated users can read waste photos'
  ) then
    create policy "Authenticated users can read waste photos"
      on storage.objects for select
      to authenticated
      using (bucket_id = 'waste-photos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Authenticated users can upload waste photos'
  ) then
    create policy "Authenticated users can upload waste photos"
      on storage.objects for insert
      to authenticated
      with check (bucket_id = 'waste-photos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Authenticated users can update waste photos'
  ) then
    create policy "Authenticated users can update waste photos"
      on storage.objects for update
      to authenticated
      using (bucket_id = 'waste-photos')
      with check (bucket_id = 'waste-photos');
  end if;
end $$;
