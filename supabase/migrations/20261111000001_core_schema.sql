-- Flowlane core schema: team, boards, columns, tasks and task details.

create schema if not exists private;

-- keeps updated_at current on every update
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

/* ---------- team ---------- */
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text not null default '' check (char_length(full_name) <= 120),
  color      text not null default '#6C5CE7' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now()
);
comment on table public.profiles is 'One row per signed-up person; created automatically on sign-up.';

create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id);

create table public.workspace_invites (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email        text not null check (email = lower(email) and email like '%_@_%'),
  role         text not null default 'member' check (role in ('owner', 'member')),
  invited_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, email)
);
create index workspace_invites_email_idx on public.workspace_invites (email);
create index workspace_invites_invited_by_idx on public.workspace_invites (invited_by);
comment on table public.workspace_invites is 'Only emails listed here can sign up; the invite is consumed on sign-up.';

/* ---------- boards ---------- */
create table public.boards (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 200),
  position     integer not null default 0,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index boards_workspace_id_idx on public.boards (workspace_id);
create index boards_created_by_idx on public.boards (created_by);

create table public.board_columns (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 120),
  position   integer not null default 0,
  collapsed  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, board_id)
);
create index board_columns_board_id_idx on public.board_columns (board_id);

create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards (id) on delete cascade,
  column_id   uuid not null,
  title       text not null check (char_length(title) between 1 and 500),
  description text not null default '' check (char_length(description) <= 20000),
  priority    text not null default 'medium' check (priority in ('urgent', 'high', 'medium', 'low')),
  assignee_id uuid references public.profiles (id) on delete set null,
  due_date    date,
  labels      text[] not null default '{}' check (cardinality(labels) <= 20),
  position    integer not null default 0,
  archived    boolean not null default false,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- a task's column must belong to the same board
  foreign key (column_id, board_id) references public.board_columns (id, board_id) on delete cascade
);
create index tasks_board_id_idx on public.tasks (board_id);
create index tasks_column_id_board_id_idx on public.tasks (column_id, board_id);
create index tasks_assignee_id_idx on public.tasks (assignee_id);
create index tasks_created_by_idx on public.tasks (created_by);

/* ---------- task details ---------- */
create table public.checklist_items (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  text       text not null check (char_length(text) <= 1000),
  done       boolean not null default false,
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index checklist_items_task_id_idx on public.checklist_items (task_id);

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null,
  body       text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index comments_task_id_idx on public.comments (task_id);
create index comments_author_id_idx on public.comments (author_id);

create table public.attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 255),
  size_bytes   bigint not null default 0 check (size_bytes >= 0),
  storage_path text,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index attachments_task_id_idx on public.attachments (task_id);
create index attachments_created_by_idx on public.attachments (created_by);
comment on column public.attachments.storage_path is 'Reserved for real file uploads (Supabase Storage); null = name-only link.';

/* ---------- updated_at triggers ---------- */
create trigger boards_updated_at          before update on public.boards          for each row execute function private.set_updated_at();
create trigger board_columns_updated_at   before update on public.board_columns   for each row execute function private.set_updated_at();
create trigger tasks_updated_at           before update on public.tasks           for each row execute function private.set_updated_at();
create trigger checklist_items_updated_at before update on public.checklist_items for each row execute function private.set_updated_at();
create trigger comments_updated_at        before update on public.comments        for each row execute function private.set_updated_at();
