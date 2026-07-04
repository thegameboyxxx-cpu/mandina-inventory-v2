create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    full_name,
    email,
    role,
    login_type,
    active
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email),
    new.email,
    'staff',
    coalesce(new.raw_user_meta_data->>'login_type', 'google'),
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
