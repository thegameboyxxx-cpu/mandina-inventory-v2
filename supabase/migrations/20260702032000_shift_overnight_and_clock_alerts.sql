alter table public.shift_schedules
  drop constraint if exists shift_schedules_time_check;

alter table public.shift_template_lines
  drop constraint if exists shift_template_lines_time_check;
