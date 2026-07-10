update public.time_entries duplicate
set
  status = 'cancelled',
  notes = trim(coalesce(duplicate.notes, '') || E'\nAuto-cancelled duplicate open clock-in created within 3 minutes of another entry.'),
  manager_edit_reason = coalesce(duplicate.manager_edit_reason, 'Auto-cancelled duplicate open clock-in'),
  updated_at = now()
where duplicate.status = 'clocked_in'
  and exists (
    select 1
    from public.time_entries kept
    where kept.employee_id = duplicate.employee_id
      and kept.id <> duplicate.id
      and kept.clock_in_at is not null
      and duplicate.clock_in_at is not null
      and abs(extract(epoch from (kept.clock_in_at - duplicate.clock_in_at))) <= 180
      and (
        kept.status = 'clocked_out'
        or (
          kept.status = 'clocked_in'
          and kept.created_at < duplicate.created_at
        )
      )
  );

create unique index if not exists time_entries_one_open_per_employee_key
  on public.time_entries(employee_id)
  where status = 'clocked_in';
