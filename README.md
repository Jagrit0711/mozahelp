# 🤖 Moza Help Bot

> The AI-powered community support bot for [Zuup](https://zuup.dev) — built on Cloudflare Workers, Supabase, and Workers AI.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jagrit0711/mozahelp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Moza is a **self-learning Slack bot** that automatically reads a channel's entire message history the moment she's added to it, embeds the conversations into a vector database, and answers future questions using semantic search. When she doesn't know the answer, she loops in the right human automatically.

---

## ✨ Features

- **🧠 Auto-ingests channel history** — The moment you add Moza to a channel, she reads all past messages, chunks them into conversational windows, and stores them as vector embeddings.
- **🔍 Semantic search** — Uses Cloudflare Workers AI (`bge-base-en-v1.5`) to find the most relevant past conversations when answering questions.
- **📌 Channel-aware** — Searches are scoped to the channel the question was asked in first, then falls back to global knowledge.
- **🎫 Ticket escalation** — When Moza can't find an answer, she creates a ticket and loops in a designated solver or `@jagrit`.
- **🙅 Smart triggering** — Only responds when directly `@mentioned` or when a message contains a `?`. Never interrupts casual chatter.
- **🚀 Edge-deployed** — Runs entirely on Cloudflare Workers. Zero cold starts. Global low-latency.

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com/) |
| Framework | [Hono](https://hono.dev/) |
| Vector DB | [Supabase pgvector](https://supabase.com/docs/guides/ai/vector-columns) |
| Embeddings | [Cloudflare Workers AI — `bge-base-en-v1.5`](https://developers.cloudflare.com/workers-ai/) |
| LLM | [Cloudflare Workers AI — `llama-3.1-8b-instruct-fast`](https://developers.cloudflare.com/workers-ai/) |
| Platform | Slack Bot (Events API) |

---

## 🚀 Self-Hosting Setup

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/) with Workers AI enabled
- A [Supabase project](https://supabase.com/)
- A [Slack App](https://api.slack.com/apps) with a Bot Token

---

### 1. Clone the repo

```bash
git clone https://github.com/Jagrit0711/mozahelp.git
cd mozahelp
npm install
```

### 2. Set up Supabase

Run the schema in your Supabase SQL editor:

```sql
-- Enable pgvector
create extension if not exists vector;

-- Main data table
create table moza_data (
  id uuid primary key default gen_random_uuid(),
  type text not null,        -- 'knowledge' | 'ticket' | 'role'
  content text not null,
  metadata jsonb default '{}',
  embedding vector(768),
  created_at timestamptz default now()
);

-- Semantic search function
create or replace function match_moza_knowledge(
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (id uuid, content text, metadata jsonb, similarity float)
language sql stable
as $$
  select id, content, metadata, 1 - (embedding <=> query_embedding) as similarity
  from moza_data
  where type = 'knowledge'
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;
```

### 3. Configure environment variables

Add your Supabase URL as a `var` in `wrangler.jsonc`:
```jsonc
"vars": {
  "SUPABASE_URL": "https://your-project.supabase.co"
}
```

Add your secrets via Wrangler CLI:
```bash
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put SLACK_BOT_TOKEN
```

### 4. Configure your Slack App

In your [Slack App settings](https://api.slack.com/apps):

**OAuth & Permissions — Bot Token Scopes:**
```
channels:history
channels:read
chat:write
app_mentions:read
```

**Event Subscriptions — Subscribe to Bot Events:**
```
app_mention
member_joined_channel
message.channels
```

Set your **Request URL** to:
```
https://<your-worker>.workers.dev/slack/events
```

**Interactivity & Shortcuts:**  
Turn **ON** and set Request URL to:
```
https://<your-worker>.workers.dev/slack/interactivity
```

### 5. Deploy

```bash
npx wrangler deploy
```

---

## 📖 Usage

### Adding Moza to a channel

Simply **invite Moza** to any channel:
```
/invite @Moza Help
```

She will immediately start reading the channel history and post a confirmation message when done.

### Triggering Moza

Moza responds when:
- Someone **directly @mentions** her: `@Moza Help what is the submission template?`
- Someone **asks a question** (any message with a `?`)

### Slash Commands

| Command | Description |
|---|---|
| `/moza-knowledge Question \| Answer` | Manually add a Q&A pair to Moza's knowledge base |
| `/moza-solver @username` | Designate a user as a solver for escalated tickets |
| `/moza-tickets` | View all currently escalated tickets |

### Bulk Ingestion (Slack Export)

To ingest a full Slack workspace export:

```bash
# Wipe old memories and re-ingest with new chunking
npx tsx scripts/ingest.ts --wipe "/path/to/slack/export"

# Or just ingest without wiping
npx tsx scripts/ingest.ts "/path/to/slack/export"
```

---

## 🤝 Contributing

This project is open source and contributions are welcome!

1. Fork the repo
2. Create your branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push: `git push origin feat/your-feature`
5. Open a Pull Request

Found a bug? Report it in the **#ifoundabug** channel on the [Zuup Slack](https://zuup.dev/join) or open a [GitHub Issue](https://github.com/Jagrit0711/mozahelp/issues).

---

## 📄 License

MIT © [Jagrit](https://github.com/Jagrit0711) & Zuup Community
