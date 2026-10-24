-- Fresh Bolt Database baseline for File Declutterer.
-- Metadata only: there is no file-byte column and no storage bucket.

create extension if not exists pgcrypto;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.file_nodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  rel_path text not null,
  kind text not null check (kind in ('file', 'dir')),
  size_bytes bigint not null check (size_bytes >= 0),
  mtime_ms bigint not null check (mtime_ms >= 0),
  content_hash text,
  protected boolean not null default false,
  quarantined boolean not null default false,
  created_at timestamptz not null default now(),
  constraint file_nodes_path_shape check (
    char_length(rel_path) between 1 and 240
    and position(E'\\' in rel_path) = 0
    and rel_path !~ '//'
    and rel_path !~ '^[A-Za-z]:'
    and rel_path !~ '(^|/)\.\.(/|$)'
    and rel_path !~ '(^|/)\.(/|$)'
  ),
  constraint file_nodes_hash_shape check (
    content_hash is null or content_hash ~ '^[A-Za-z0-9._:-]{1,128}$'
  )
);

create unique index file_nodes_workspace_path_ci
  on public.file_nodes (workspace_id, lower(rel_path));

create index file_nodes_hash_idx
  on public.file_nodes (workspace_id, content_hash)
  where content_hash is not null;

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('rules', 'ai')),
  status text not null check (status in ('draft', 'validated', 'applied', 'rejected')),
  model text check (model is null or char_length(model) <= 80),
  created_at timestamptz not null default now()
);

create table public.plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid references public.file_nodes (id) on delete set null,
  from_path text not null,
  proposed_path text not null,
  accepted_path text not null,
  decision text not null check (decision in ('accept', 'edit', 'skip')),
  created_at timestamptz not null default now()
);

create table public.journals (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  plan_id uuid references public.plans (id) on delete set null,
  kind text not null check (kind in ('apply', 'undo', 'quarantine')),
  status text not null check (status in ('open', 'committed', 'rolled_back', 'needs_recovery')),
  created_at timestamptz not null default now()
);

create index journals_workspace_status_idx
  on public.journals (workspace_id, status);

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.journals (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq integer not null check (seq > 0),
  op text not null check (op in ('mkdir', 'rename', 'quarantine')),
  -- Not a foreign key. A mkdir entry is stored before that directory row exists.
  node_id uuid,
  from_path text not null,
  to_path text not null,
  restore_path text not null default '',
  size_bytes bigint,
  mtime_ms bigint,
  phase text not null check (phase in ('planned', 'done', 'undone', 'blocked')),
  note text not null default '',
  unique (journal_id, seq)
);

create table public.proposal_usage (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  day date not null,
  used_count integer not null check (used_count >= 0)
);

create or replace function public.sync_quarantine_flag()
returns trigger
language plpgsql
as $$
begin
  new.quarantined := lower(new.rel_path) like '.quarantine/%';
  return new;
end;
$$;

create trigger file_nodes_sync_quarantine
  before insert or update of rel_path on public.file_nodes
  for each row execute function public.sync_quarantine_flag();

-- 20 AI proposal attempts per user per UTC day. Raising the exception rolls the increment back.
create or replace function public.consume_proposal_credit()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  used integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.proposal_usage (owner_id, day, used_count)
  values (auth.uid(), (timezone('utc', now()))::date, 1)
  on conflict (owner_id) do update
  set
    used_count = case
      when public.proposal_usage.day = excluded.day then public.proposal_usage.used_count + 1
      else 1
    end,
    day = excluded.day
  returning used_count into used;

  if used > 20 then
    raise exception 'daily proposal limit reached';
  end if;

  return used;
end;
$$;

alter table public.workspaces enable row level security;
alter table public.file_nodes enable row level security;
alter table public.plans enable row level security;
alter table public.plan_items enable row level security;
alter table public.journals enable row level security;
alter table public.journal_entries enable row level security;
alter table public.proposal_usage enable row level security;

create policy workspaces_owner on public.workspaces
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy file_nodes_owner on public.file_nodes
  for all to authenticated
  using (
    owner_id = auth.uid()
    and exists (
      select 1 from public.workspaces as workspace
      where workspace.id = file_nodes.workspace_id
        and workspace.owner_id = auth.uid()
    )
  )
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.workspaces as workspace
        where workspace.id = workspace_id
        and workspace.owner_id = auth.uid()
    )
  );

create policy plans_owner on public.plans
  for all to authenticated
  using (
    owner_id = auth.uid()
    and exists (
      select 1 from public.workspaces as workspace
      where workspace.id = plans.workspace_id
        and workspace.owner_id = auth.uid()
    )
  )
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.workspaces as workspace
      where workspace.id = workspace_id
        and workspace.owner_id = auth.uid()
    )
  );

create policy plan_items_owner on public.plan_items
  for all to authenticated
  using (
    owner_id = auth.uid()
    and exists (
      select 1 from public.plans as plan
      where plan.id = plan_items.plan_id
        and plan.owner_id = auth.uid()
        and plan.workspace_id = plan_items.workspace_id
    )
  )
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.plans as plan
      where plan.id = plan_id
        and plan.owner_id = auth.uid()
        and plan.workspace_id = workspace_id
    )
  );

create policy journals_owner on public.journals
  for all to authenticated
  using (
    owner_id = auth.uid()
    and exists (
      select 1 from public.workspaces as workspace
      where workspace.id = journals.workspace_id
        and workspace.owner_id = auth.uid()
    )
  )
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.workspaces as workspace
      where workspace.id = workspace_id
        and workspace.owner_id = auth.uid()
    )
  );

create policy journal_entries_owner on public.journal_entries
  for all to authenticated
  using (
    owner_id = auth.uid()
    and exists (
      select 1 from public.journals as journal
      where journal.id = journal_entries.journal_id
        and journal.owner_id = auth.uid()
        and journal.workspace_id = journal_entries.workspace_id
    )
  )
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.journals as journal
      where journal.id = journal_id
        and journal.owner_id = auth.uid()
        and journal.workspace_id = workspace_id
    )
  );

create policy proposal_usage_select_own on public.proposal_usage
  for select to authenticated
  using (owner_id = auth.uid());

revoke all on public.workspaces, public.file_nodes, public.plans, public.plan_items, public.journals, public.journal_entries
  from public, anon;
grant select, insert, update, delete on public.workspaces, public.file_nodes, public.plans, public.plan_items, public.journals, public.journal_entries
  to authenticated;

revoke all on public.proposal_usage from public, anon, authenticated;
grant select on public.proposal_usage to authenticated;

revoke all on function public.consume_proposal_credit() from public, anon;
grant execute on function public.consume_proposal_credit() to authenticated;

revoke all on function public.sync_quarantine_flag() from public, anon, authenticated;
