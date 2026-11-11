-- Flowlane: sign-up by invite, team membership and row-level security.

grant usage on schema private to authenticated;

/* ---------- access helpers (security definer, so policies don't recurse) ---------- */
create or replace function private.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = ws and m.user_id = (select auth.uid()));
$$;

create or replace function private.is_owner(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = 'owner');
$$;

create or replace function private.shares_workspace(other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members a
                 join public.workspace_members b on b.workspace_id = a.workspace_id
                 where a.user_id = (select auth.uid()) and b.user_id = other);
$$;

create or replace function private.can_access_board(board uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.boards x
                 join public.workspace_members m on m.workspace_id = x.workspace_id
                 where x.id = board and m.user_id = (select auth.uid()));
$$;

create or replace function private.can_access_task(task uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t
                 join public.boards x on x.id = t.board_id
                 join public.workspace_members m on m.workspace_id = x.workspace_id
                 where t.id = task and m.user_id = (select auth.uid()));
$$;

/* ---------- creator columns are always the signed-in user and never change ---------- */
create or replace function private.stamp_creator()
returns trigger language plpgsql set search_path = '' as $$
declare col text := tg_argv[0];
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new := jsonb_populate_record(new, jsonb_build_object(col, auth.uid()));
    end if;
  else
    new := jsonb_populate_record(new, jsonb_build_object(col, to_jsonb(old) -> col));
  end if;
  return new;
end $$;

create trigger boards_stamp_creator      before insert or update on public.boards      for each row execute function private.stamp_creator('created_by');
create trigger tasks_stamp_creator       before insert or update on public.tasks       for each row execute function private.stamp_creator('created_by');
create trigger comments_stamp_author     before insert or update on public.comments    for each row execute function private.stamp_creator('author_id');
create trigger attachments_stamp_creator before insert or update on public.attachments for each row execute function private.stamp_creator('created_by');

/* ---------- sign-up: only invited emails; profile + membership created automatically ---------- */
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  em text := lower(new.email);
  palette text[] := array['#6C5CE7','#00B894','#3C8DF0','#E84393','#F0A93B','#00A8B5','#FF5C68','#5A49D6'];
begin
  if not exists (select 1 from public.workspace_invites where email = em) then
    raise exception 'FLOWLANE_NOT_INVITED: % has not been invited', em using errcode = 'P0001';
  end if;
  insert into public.profiles (id, email, full_name, color)
  values (new.id, em,
          left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(em, '@', 1)), 120),
          palette[1 + floor(random() * array_length(palette, 1))::int]);
  insert into public.workspace_members (workspace_id, user_id, role)
  select workspace_id, new.id, role from public.workspace_invites where email = em
  on conflict do nothing;
  delete from public.workspace_invites where email = em;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

/* ---------- inviting someone who already has an account adds them straight away ---------- */
create or replace function private.handle_new_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
declare existing uuid;
begin
  new.email := lower(trim(new.email));
  new.invited_by := coalesce(auth.uid(), new.invited_by);
  select id into existing from public.profiles where email = new.email;
  if existing is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.workspace_id, existing, new.role)
    on conflict do nothing;
    return null;
  end if;
  return new;
end $$;

create trigger workspace_invites_before_insert
  before insert on public.workspace_invites
  for each row execute function private.handle_new_invite();

/* ---------- privileges ---------- */
revoke all on all tables in schema public from anon;
revoke update on public.profiles from authenticated;
grant update (full_name, color) on public.profiles to authenticated;

/* ---------- row-level security ---------- */
alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.boards            enable row level security;
alter table public.board_columns     enable row level security;
alter table public.tasks             enable row level security;
alter table public.checklist_items   enable row level security;
alter table public.comments          enable row level security;
alter table public.attachments       enable row level security;

-- profiles: see yourself and teammates; edit only your own name/colour
create policy "profiles: read self and teammates" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_workspace(id));
create policy "profiles: update self" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- workspaces: members read, owners rename
create policy "workspaces: members read" on public.workspaces for select to authenticated
  using (private.is_member(id));
create policy "workspaces: owners update" on public.workspaces for update to authenticated
  using (private.is_owner(id)) with check (private.is_owner(id));

-- members: members see the team, owners remove others
create policy "members: members read" on public.workspace_members for select to authenticated
  using (private.is_member(workspace_id));
create policy "members: owners remove others" on public.workspace_members for delete to authenticated
  using (private.is_owner(workspace_id) and user_id <> (select auth.uid()));

-- invites: members see pending invites, owners add and revoke
create policy "invites: members read" on public.workspace_invites for select to authenticated
  using (private.is_member(workspace_id));
create policy "invites: owners add" on public.workspace_invites for insert to authenticated
  with check (private.is_owner(workspace_id));
create policy "invites: owners revoke" on public.workspace_invites for delete to authenticated
  using (private.is_owner(workspace_id));

-- boards: any workspace member
create policy "boards: members read"   on public.boards for select to authenticated using (private.is_member(workspace_id));
create policy "boards: members create" on public.boards for insert to authenticated with check (private.is_member(workspace_id));
create policy "boards: members update" on public.boards for update to authenticated using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy "boards: members delete" on public.boards for delete to authenticated using (private.is_member(workspace_id));

-- columns and tasks: anyone who can open the board
create policy "columns: board access" on public.board_columns for all to authenticated
  using (private.can_access_board(board_id)) with check (private.can_access_board(board_id));
create policy "tasks: board access" on public.tasks for all to authenticated
  using (private.can_access_board(board_id)) with check (private.can_access_board(board_id));

-- checklist and attachments: anyone who can open the task
create policy "checklist: task access" on public.checklist_items for all to authenticated
  using (private.can_access_task(task_id)) with check (private.can_access_task(task_id));
create policy "attachments: task access" on public.attachments for all to authenticated
  using (private.can_access_task(task_id)) with check (private.can_access_task(task_id));

-- comments: everyone on the task reads and posts; only the author edits or deletes
create policy "comments: task access read" on public.comments for select to authenticated
  using (private.can_access_task(task_id));
create policy "comments: post" on public.comments for insert to authenticated
  with check (private.can_access_task(task_id));
create policy "comments: author edits" on public.comments for update to authenticated
  using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "comments: author deletes" on public.comments for delete to authenticated
  using (author_id = (select auth.uid()));

/* ---------- first workspace and its owner ---------- */
-- Replace owner@example.com with the owner's email (lowercase) before applying to a new project.
with ws as (insert into public.workspaces (name) values ('Product team') returning id)
insert into public.workspace_invites (workspace_id, email, role)
select id, 'owner@example.com', 'owner' from ws;
