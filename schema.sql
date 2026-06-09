-- Ensure pgvector extension is enabled
create extension if not exists vector;

-- Drop table if exists
drop table if exists public.moza_data cascade;

-- Single table to hold all application state
create table public.moza_data (
  id uuid primary key default gen_random_uuid(),
  type text not null, -- 'knowledge', 'ticket', 'role'
  content text not null, -- Question text or User ID for roles
  metadata jsonb default '{}'::jsonb, -- Flexible storage (answer, status, etc.)
  embedding vector(768), -- Embedding vector (only used for 'knowledge')
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Index for vector search (using inner product)
create index on public.moza_data using ivfflat (embedding vector_ip_ops) with (lists = 100);

-- RPC Function for searching the knowledge base
create or replace function match_moza_knowledge(
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    moza_data.id,
    moza_data.content,
    moza_data.metadata,
    1 - (moza_data.embedding <=> query_embedding) as similarity
  from moza_data
  where type = 'knowledge'
    and 1 - (moza_data.embedding <=> query_embedding) > match_threshold
  order by (moza_data.embedding <=> query_embedding) asc
  limit match_count;
$$;
