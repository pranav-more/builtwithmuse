-- Creator Pool schema, 2026-09-25. Idempotent: safe to run again.
-- Applied by hand with psql against the Supabase session pooler (see README).
--
-- Authorship and events are stored once; reputation is computed by views
-- from the ratings themselves and is never stored as editable profile data.

create extension if not exists pgcrypto;

create table if not exists pool_settings (
  key text primary key,
  value text not null
);
insert into pool_settings (key, value) values ('prior_weight', '5') on conflict (key) do nothing;
insert into pool_settings (key, value) values ('report_hide_threshold', '3') on conflict (key) do nothing;
insert into pool_settings (key, value) values ('submissions_open', 'true') on conflict (key) do nothing;

create table if not exists categories (
  id serial primary key,
  slug text not null unique,
  name text not null,
  position int not null default 0,
  active boolean not null default true
);
insert into categories (slug, name, position) values
  ('shopping', 'Shopping', 10),
  ('money', 'Money', 20),
  ('life-admin', 'Life admin', 30),
  ('work', 'Work', 40),
  ('creators', 'Creators', 50),
  ('productivity', 'Productivity', 60),
  ('health', 'Health and fitness', 70),
  ('travel', 'Travel', 80),
  ('research', 'Research', 90),
  ('developers', 'Developers', 100)
on conflict (slug) do nothing;

create table if not exists creator_profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  google_sub text,
  handle text not null,
  display_name text not null,
  bio text,
  avatar_url text,
  website_url text,
  x_url text,
  youtube_url text,
  instagram_url text,
  tiktok_url text,
  status text not null default 'active' check (status in ('active', 'deactivated', 'removed')),
  is_editorial boolean not null default false,
  handle_changed_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists creator_profiles_email_idx on creator_profiles (lower(email));
create unique index if not exists creator_profiles_handle_idx on creator_profiles (lower(handle));

create table if not exists creator_devices (
  creator_id uuid not null references creator_profiles(id) on delete cascade,
  device_id text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (creator_id, device_id)
);
create index if not exists creator_devices_device_idx on creator_devices (device_id);

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creator_profiles(id),
  slug text not null,
  title text not null,
  summary text not null default '',
  problem text not null default '',
  result text not null default '',
  prompt text,
  proof_url text,
  category_id int references categories(id),
  tags text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published', 'unpublished', 'removed')),
  -- Set by an administrator when a removal is for reasons unrelated to the
  -- work itself, so the ratings stop counting toward creator reputation.
  exclude_from_reputation boolean not null default false,
  hidden_at timestamptz,
  removed_reason text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists workflows_slug_idx on workflows (slug);
create index if not exists workflows_creator_idx on workflows (creator_id, status);
create index if not exists workflows_published_idx on workflows (published_at desc) where status = 'published';
create index if not exists workflows_category_idx on workflows (category_id) where status = 'published';

create table if not exists workflow_steps (
  id serial primary key,
  workflow_id uuid not null references workflows(id) on delete cascade,
  position int not null,
  title text,
  body text not null,
  unique (workflow_id, position)
);

create table if not exists workflow_prerequisites (
  id serial primary key,
  workflow_id uuid not null references workflows(id) on delete cascade,
  position int not null,
  body text not null,
  unique (workflow_id, position)
);

create table if not exists workflow_ratings (
  id serial primary key,
  workflow_id uuid not null references workflows(id) on delete cascade,
  device_id text not null,
  rater_creator_id uuid references creator_profiles(id),
  score int not null check (score between 1 and 5),
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_id, device_id)
);
create index if not exists workflow_ratings_device_idx on workflow_ratings (device_id, created_at desc);
create index if not exists workflow_ratings_ip_idx on workflow_ratings (ip_hash, created_at desc);

create table if not exists workflow_reports (
  id serial primary key,
  workflow_id uuid not null references workflows(id) on delete cascade,
  device_id text not null,
  reporter_creator_id uuid references creator_profiles(id),
  reason text not null check (reason in ('spam', 'unsafe', 'stolen', 'other')),
  detail text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  ip_hash text,
  created_at timestamptz not null default now(),
  unique (workflow_id, device_id)
);
create index if not exists workflow_reports_open_idx on workflow_reports (created_at desc) where status = 'open';
create index if not exists workflow_reports_device_idx on workflow_reports (device_id, created_at desc);

create table if not exists workflow_revisions (
  id serial primary key,
  workflow_id uuid not null references workflows(id) on delete cascade,
  editor_id uuid references creator_profiles(id),
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

-- Audit trail for every sensitive write: ratings, reports, status changes,
-- admin actions. Never shown publicly.
create table if not exists workflow_saves (
  workflow_id uuid not null references workflows(id) on delete cascade,
  device_id text not null,
  created_at timestamptz not null default now(),
  primary key (workflow_id, device_id)
);
create index if not exists workflow_saves_device_idx on workflow_saves (device_id);

create table if not exists workflow_comments (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  creator_id uuid not null references creator_profiles(id) on delete cascade,
  body text not null,
  hidden_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists workflow_comments_workflow_idx on workflow_comments (workflow_id, created_at);

create table if not exists comment_likes (
  comment_id uuid not null references workflow_comments(id) on delete cascade,
  creator_id uuid not null references creator_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, creator_id)
);

create table if not exists comment_reports (
  id serial primary key,
  comment_id uuid not null references workflow_comments(id) on delete cascade,
  device_id text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (comment_id, device_id)
);

create table if not exists pool_events (
  id serial primary key,
  kind text not null,
  workflow_id uuid,
  creator_id uuid,
  device_id text,
  actor text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pool_events_created_idx on pool_events (created_at desc);

-- Only the server's own connection reads these tables. Row level security
-- with no policies keeps any anon key out; the postgres role bypasses it.
alter table creator_profiles enable row level security;
alter table creator_devices enable row level security;
alter table workflows enable row level security;
alter table workflow_steps enable row level security;
alter table workflow_prerequisites enable row level security;
alter table workflow_ratings enable row level security;
alter table workflow_reports enable row level security;
alter table workflow_revisions enable row level security;
alter table pool_events enable row level security;
alter table pool_settings enable row level security;
alter table categories enable row level security;

-- Pool wide numbers the weighting needs: the prior weight (configurable) and
-- the average rating across every published workflow.
create or replace view pool_prior as
  select
    coalesce((select value::numeric from pool_settings where key = 'prior_weight'), 5) as prior_weight,
    coalesce((select avg(r.score)::numeric from workflow_ratings r join workflows w on w.id = r.workflow_id where w.status = 'published'), 3.5) as pool_average;

-- score = n/(n+m) * average + m/(n+m) * pool average, where m is the prior
-- weight. With no ratings the score is the pool average, so a new workflow
-- ranks below anything with proof and above nothing in particular.
create or replace view workflow_stats as
  select
    w.id as workflow_id,
    count(r.id)::int as rating_count,
    avg(r.score)::numeric(4,2) as average,
    round(
      (count(r.id) / (count(r.id) + p.prior_weight)) * coalesce(avg(r.score), 0)
      + (p.prior_weight / (count(r.id) + p.prior_weight)) * p.pool_average,
      3)::numeric(5,3) as weighted_score
  from workflows w
  cross join pool_prior p
  left join workflow_ratings r on r.workflow_id = w.id
  group by w.id, p.prior_weight, p.pool_average;

-- A creator's reputation counts ratings on every workflow they published,
-- including ones since unpublished, so poor work cannot be erased. Only an
-- administrator exclusion (unrelated safety removal) drops a workflow out.
create or replace view creator_stats as
  select
    c.id as creator_id,
    (select count(*) from workflows w where w.creator_id = c.id and w.status = 'published')::int as workflow_count,
    count(r.id)::int as rating_count,
    avg(r.score)::numeric(4,2) as average,
    round(
      (count(r.id) / (count(r.id) + p.prior_weight)) * coalesce(avg(r.score), 0)
      + (p.prior_weight / (count(r.id) + p.prior_weight)) * p.pool_average,
      3)::numeric(5,3) as weighted_score
  from creator_profiles c
  cross join pool_prior p
  left join workflows w on w.creator_id = c.id and w.status in ('published', 'unpublished', 'removed') and not w.exclude_from_reputation
  left join workflow_ratings r on r.workflow_id = w.id
  group by c.id, p.prior_weight, p.pool_average;

-- The editorial account owns researched seed workflows until a creator
-- claims them. Clearly labelled, never presented as community authored.
insert into creator_profiles (email, handle, display_name, bio, website_url, is_editorial)
values ('editorial@builtwithmuse.com', 'builtwithmuse', 'Jayesh', 'Researched workflows written up by the Built with Muse team from public reports and Meta''s own announcements. Not community authored. If one of these is your work, get in touch and claim it.', 'https://builtwithmuse.com', true)
on conflict (lower(email)) do nothing;
-- Attributed to Jayesh while keeping the editorial flag. Seeded workflows
-- are editorial content, not fake community submissions.
update creator_profiles set display_name = 'Jayesh' where is_editorial and display_name = 'Built with Muse editorial';
