-- Flowlane: activity log written by the database itself, plus realtime publication.

create table public.activity (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  board_id     uuid references public.boards (id) on delete set null,
  task_id      uuid,                       -- no FK: history survives task deletion
  actor_id     uuid references public.profiles (id) on delete set null,
  action       text not null,
  details      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index activity_workspace_created_idx on public.activity (workspace_id, created_at desc);
create index activity_board_created_idx on public.activity (board_id, created_at desc);
create index activity_actor_id_idx on public.activity (actor_id);
comment on table public.activity is 'Who did what and when. Rows are only written by triggers, never by clients.';

revoke all on public.activity from anon;
alter table public.activity enable row level security;
create policy "activity: members read" on public.activity for select to authenticated
  using (private.is_member(workspace_id));
-- no insert/update/delete policies: clients cannot write or alter history

create or replace function private.log_activity(ws uuid, board uuid, task uuid, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.activity (workspace_id, board_id, task_id, actor_id, action, details)
  values (ws, board, task, (select auth.uid()), act, info);
$$;

/* ---------- boards ---------- */
create or replace function private.track_boards()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.workspace_id, new.id, null, 'board_created', jsonb_build_object('name', new.name));
  elsif tg_op = 'UPDATE' then
    if new.name is distinct from old.name then
      perform private.log_activity(new.workspace_id, new.id, null, 'board_renamed', jsonb_build_object('name', new.name, 'from', old.name));
    end if;
  elsif tg_op = 'DELETE' then
    if exists (select 1 from public.workspaces where id = old.workspace_id) then
      perform private.log_activity(old.workspace_id, null, null, 'board_deleted', jsonb_build_object('name', old.name));
    end if;
  end if;
  return null;
end $$;
create trigger boards_track after insert or update or delete on public.boards
  for each row execute function private.track_boards();

/* ---------- columns ---------- */
create or replace function private.track_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ws uuid;
begin
  select workspace_id into ws from public.boards where id = coalesce(new.board_id, old.board_id);
  if ws is null then return null; end if;              -- board is being deleted
  if tg_op = 'INSERT' then
    perform private.log_activity(ws, new.board_id, null, 'column_added', jsonb_build_object('title', new.title));
  elsif tg_op = 'UPDATE' then
    if new.title is distinct from old.title then
      perform private.log_activity(ws, new.board_id, null, 'column_renamed', jsonb_build_object('title', new.title, 'from', old.title));
    end if;
  elsif tg_op = 'DELETE' then
    perform private.log_activity(ws, old.board_id, null, 'column_deleted', jsonb_build_object('title', old.title));
  end if;
  return null;
end $$;
create trigger board_columns_track after insert or update or delete on public.board_columns
  for each row execute function private.track_columns();

/* ---------- tasks ---------- */
create or replace function private.track_tasks()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  changed text[] := '{}';
begin
  select workspace_id into ws from public.boards where id = coalesce(new.board_id, old.board_id);
  if ws is null then return null; end if;              -- board is being deleted

  if tg_op = 'INSERT' then
    perform private.log_activity(ws, new.board_id, new.id, 'task_created', jsonb_build_object(
      'title', new.title,
      'column', (select title from public.board_columns where id = new.column_id)));

  elsif tg_op = 'DELETE' then
    if exists (select 1 from public.board_columns where id = old.column_id) then  -- skip when its column is deleted
      perform private.log_activity(ws, old.board_id, old.id, 'task_deleted', jsonb_build_object('title', old.title));
    end if;

  else
    if new.archived is distinct from old.archived then
      perform private.log_activity(ws, new.board_id, new.id,
        case when new.archived then 'task_archived' else 'task_restored' end,
        jsonb_build_object('title', new.title));
    end if;
    if new.column_id is distinct from old.column_id then
      perform private.log_activity(ws, new.board_id, new.id, 'task_moved', jsonb_build_object(
        'title', new.title,
        'from', (select title from public.board_columns where id = old.column_id),
        'to',   (select title from public.board_columns where id = new.column_id)));
    end if;
    if new.title       is distinct from old.title       then changed := changed || 'title'::text; end if;
    if new.description is distinct from old.description then changed := changed || 'description'::text; end if;
    if new.priority    is distinct from old.priority    then changed := changed || 'priority'::text; end if;
    if new.assignee_id is distinct from old.assignee_id then changed := changed || 'assignee'::text; end if;
    if new.due_date    is distinct from old.due_date    then changed := changed || 'due date'::text; end if;
    if new.labels      is distinct from old.labels      then changed := changed || 'labels'::text; end if;
    if cardinality(changed) > 0 then
      perform private.log_activity(ws, new.board_id, new.id, 'task_edited', jsonb_build_object(
        'title', new.title, 'fields', to_jsonb(changed), 'priority', new.priority,
        'assignee', (select full_name from public.profiles where id = new.assignee_id)));
    end if;
  end if;
  return null;
end $$;
create trigger tasks_track after insert or update or delete on public.tasks
  for each row execute function private.track_tasks();

/* ---------- comments and checklist completions ---------- */
create or replace function private.track_task_details()
returns trigger language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  select tk.id, tk.title, tk.board_id, b.workspace_id into t
  from public.tasks tk join public.boards b on b.id = tk.board_id where tk.id = new.task_id;
  if t.id is null then return null; end if;
  if tg_table_name = 'comments' then
    perform private.log_activity(t.workspace_id, t.board_id, t.id, 'comment_added', jsonb_build_object('title', t.title));
  elsif tg_table_name = 'checklist_items' and new.done and (tg_op = 'INSERT' or not old.done) then
    perform private.log_activity(t.workspace_id, t.board_id, t.id, 'checklist_completed', jsonb_build_object('title', t.title, 'item', new.text));
  end if;
  return null;
end $$;
create trigger comments_track after insert on public.comments
  for each row execute function private.track_task_details();
create trigger checklist_items_track after insert or update of done on public.checklist_items
  for each row execute function private.track_task_details();

/* ---------- realtime ---------- */
alter publication supabase_realtime add table
  public.boards, public.board_columns, public.tasks, public.checklist_items,
  public.comments, public.attachments, public.activity,
  public.profiles, public.workspace_members, public.workspace_invites;
