alter table public.profiles
  add column if not exists branch_ids text[];

alter table public.user_invites
  add column if not exists branch_ids text[];

update public.profiles
set branch_ids = array[branch_id]
where branch_ids is null
  and branch_id is not null;

update public.user_invites
set branch_ids = array[branch_id]
where branch_ids is null
  and branch_id is not null;
