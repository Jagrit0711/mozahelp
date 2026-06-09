import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

export type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  AI: any;
  SLACK_BOT_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => c.text('Zuup Zuup! Moza is running!'));

// --- SLACK EVENTS HANDLER (Messages) ---
app.post('/slack/events', async (c) => {
  const body = await c.req.json();

  if (body.type === 'url_verification') {
    return c.json({ challenge: body.challenge });
  }

  if (body.type === 'event_callback') {
    const event = body.event;
    
    if (event.bot_id) return c.text('ok'); // Ignore bots

    // When bot is added to a channel, auto-ingest the channel history
    if (event.type === 'member_joined_channel' && event.user === body.authorizations?.[0]?.user_id) {
      c.executionCtx.waitUntil(
        ingestChannelHistory(event.channel, c.env).catch(e => console.error("Error ingesting channel history:", e))
      );
    }

    if ((event.type === 'message' && event.channel_type === 'channel') || event.type === 'app_mention') {
      c.executionCtx.waitUntil(
        handleIncomingMessage(event, c.env).catch(async (e) => {
          console.error("Error handling message:", e);
          try {
            await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${c.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                channel: event.channel,
                text: `Zuup... I completely crashed! Here is the error: \`${e.message || JSON.stringify(e)}\``
              })
            });
          } catch (err) {}
        })
      );
    }
  }

  return c.text('ok');
});

// --- SLACK COMMANDS HANDLER ---
app.post('/slack/commands', async (c) => {
  const body = await c.req.parseBody();
  const command = body.command as string;
  const text = body.text as string;
  const userId = body.user_id as string;
  
  c.executionCtx.waitUntil(handleCommand(command, text, userId, c.env).catch(e => console.error("Error handling command:", e)));
  
  // Acknowledge command receipt immediately
  return c.json({
    response_type: "ephemeral",
    text: "Zuup! Moza is on it!"
  });
});

// --- SLACK INTERACTIVITY HANDLER ---
app.post('/slack/interactivity', async (c) => {
  const body = await c.req.parseBody();
  const payloadStr = body.payload;
  if (typeof payloadStr !== 'string') return c.text('ok');

  const payload = JSON.parse(payloadStr);

  if (payload.type === 'block_actions') {
    c.executionCtx.waitUntil(handleInteractivity(payload, c.env));
  }

  return c.text('ok');
});

// --- BULK INGESTION HANDLER ---
app.post('/slack/ingest-batch', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  if (authHeader.trim() !== `Bearer ${c.env.SLACK_BOT_TOKEN?.trim()}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { messages } = await c.req.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  c.executionCtx.waitUntil(handleBulkIngest(messages, c.env).catch(e => console.error("Bulk ingest error:", e)));
  
  return c.json({ status: 'processing', count: messages.length });
});

// --- WIPE KNOWLEDGE HANDLER ---
app.delete('/slack/wipe-knowledge', async (c) => {
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('moza_data').delete().eq('type', 'knowledge');
  if (error) return c.json({ error }, 500);
  return c.json({ status: 'wiped' });
});

// --- CORE LOGIC ---

// Auto-ingest all channel history when bot joins a channel
async function ingestChannelHistory(channelId: string, env: Bindings) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  
  // Notify the channel that Moza is reading history
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, text: "📚 Hey! I'm Moza, the AI support for the Zuup community. I'm reading through this channel's history so I can answer questions. Give me a moment!" })
  });

  let allMessages: any[] = [];
  let cursor: string | undefined;

  // Paginate through ALL channel history
  do {
    const params: any = { channel: channelId, limit: 200 };
    if (cursor) params.cursor = cursor;
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`https://slack.com/api/conversations.history?${qs}`, {
      headers: { 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}` }
    });
    const data: any = await res.json();
    if (!data.ok) break;
    const validMsgs = (data.messages || []).filter((m: any) => !m.bot_id && !m.subtype && typeof m.text === 'string' && m.text.length > 5);
    allMessages = allMessages.concat(validMsgs.reverse()); // reverse so oldest first
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);

  if (allMessages.length === 0) return;

  // Sliding window chunking: 10 msgs per chunk, step of 5
  const CHUNK_SIZE = 10;
  const STEP_SIZE = 5;
  for (let i = 0; i < allMessages.length; i += STEP_SIZE) {
    const chunk = allMessages.slice(i, i + CHUNK_SIZE);
    const chunkText = chunk.map((m: any) => m.text).join('\n\n');

    try {
      const { data: embeddings } = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [chunkText] });
      await supabase.from('moza_data').insert({
        type: 'knowledge',
        content: chunkText,
        metadata: { channel_id: channelId, source: 'channel_history' },
        embedding: embeddings[0]
      });
    } catch (e) {
      console.error('Error embedding chunk:', e);
    }

    if (i + CHUNK_SIZE >= allMessages.length) break;
  }

  // Notify done
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, text: `✅ Done! I've read ${allMessages.length} messages from this channel. Ask me anything!` })
  });
}

async function handleIncomingMessage(event: any, env: Bindings) {
  const { text, channel, ts } = event;
  const thread_ts = event.thread_ts || ts;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  // 1. Generate Embedding
  const { data: embeddings } = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
  const vector = embeddings[0];

  // 2. Query Supabase RPC for similar knowledge — filtered to this channel
  const { data: matches } = await supabase.rpc('match_moza_knowledge', {
    query_embedding: vector,
    match_threshold: 0.40,
    match_count: 20
  });

  // Prefer matches from the same channel, fall back to global
  const channelMatches = matches?.filter((m: any) => m.metadata?.channel_id === channel) || [];
  const finalMatches = channelMatches.length > 0 ? channelMatches : (matches || []);

  let promptContext = "";
  if (finalMatches.length > 0) {
    promptContext = finalMatches.map((m: any) => m.content).join('\n\n---\n\n');
  }

  // 3. Ask Moza AI to solve
  const systemPrompt = `You are Moza, the AI support for the Zuup community.
CRITICAL INSTRUCTIONS:
1. You must ONLY introduce yourself as exactly: "My name is Moza and the AI support for the Zuup community. Zuup is cool." Do not add anything else to your introduction.
2. If the user asks an off-topic question, or if the Context below does NOT contain the exact answer, you MUST reply with exactly this exact phrase and nothing else: "I don't think I should answer it, my knowledge is limited to this channel."
3. Do not output CANNOT_ANSWER anymore. Just output the exact phrase: "I don't think I should answer it, my knowledge is limited to this channel."
4. If the Context DOES contain the answer, answer the question accurately using ONLY the facts from the Context.

Context:
${promptContext}
`;

  const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ]
  });

  const aiAnswer = response.response.trim();

  // DEBUG: Show the user exactly what context was retrieved
  const debugContext = finalMatches.length > 0 
    ? `\n\n---\n*🔍 Memories Retrieved (${finalMatches.length}):*\n${finalMatches.slice(0, 3).map((m: any) => `> "${m.content.substring(0, 100).replace(/\n/g, ' ')}..."`).join('\n')}`
    : `\n\n---\n*🔍 Memories Retrieved:* None!`;

  if (aiAnswer.includes("my knowledge is limited to this channel")) {
    // 4. Ticket Flow
    // Create Ticket
    const { data: ticket, error: ticketError } = await supabase.from('moza_data').insert({
      type: 'ticket',
      content: text,
      metadata: { status: 'open', channel_id: channel, thread_ts: ts }
    }).select().single();

    if (ticketError || !ticket) {
      await postSlackMessage(env.SLACK_BOT_TOKEN, channel, ts, `Zuup... I tried to create a ticket but my database threw an error: ${JSON.stringify(ticketError)}`);
      return;
    }

    // Fetch Managers/Solvers
    const { data: roles } = await supabase.from('moza_data').select('content').eq('type', 'role').eq('metadata->>role', 'solver');
    const tags = roles && roles.length > 0 ? roles.map(r => `<@${r.content}>`).join(' ') : "team";

    // Send Ticket Message
    await postSlackMessage(env.SLACK_BOT_TOKEN, channel, thread_ts, 
      `Zuup Zuup! I checked my memory but I'm not sure about this one. Tagging my solver friends! ${tags}`, 
      [
        {
          type: "section",
          text: { type: "mrkdwn", text: `I couldn't solve this automatically. Solvers, can you help?` + debugContext }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Escalate to Admin" },
              style: "danger",
              value: ticket.id,
              action_id: "escalate_ticket"
            }
          ]
        }
      ]
    );
  } else {
    // Reply with Moza's answer
    await postSlackMessage(env.SLACK_BOT_TOKEN, channel, thread_ts, aiAnswer + debugContext);
  }
}

async function handleCommand(command: string, text: string, userId: string, env: Bindings) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  
  if (command === '/moza-knowledge') {
    const parts = text.split('|');
    if (parts.length < 2) return sendEphemeralResponse(env.SLACK_BOT_TOKEN, userId, "Format must be: Question | Answer");
    
    const question = parts[0].trim();
    const answer = parts[1].trim();

    // Embed the question
    const { data: embeddings } = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [question] });
    const vector = embeddings[0];

    // Store in Supabase
    await supabase.from('moza_data').insert({
      type: 'knowledge',
      content: question,
      metadata: { answer },
      embedding: vector
    });

    await sendEphemeralResponse(env.SLACK_BOT_TOKEN, userId, `Zuup! Added to knowledge base: "${question}"`);
  } 
  
  else if (command === '/moza-solver') {
    // Expected text: @username (usually format is <@U123456|username>)
    const userIdMatch = text.match(/<@([A-Z0-9]+)\|.*>/) || text.match(/<@([A-Z0-9]+)>/);
    const targetUserId = userIdMatch ? userIdMatch[1] : text.replace('@', '').trim();

    if (!targetUserId) return sendEphemeralResponse(env.SLACK_BOT_TOKEN, userId, "Please tag a valid user.");

    await supabase.from('moza_data').insert({
      type: 'role',
      content: targetUserId,
      metadata: { role: 'solver' }
    });

    await sendEphemeralResponse(env.SLACK_BOT_TOKEN, userId, `Zuup! Added <@${targetUserId}> as a solver!`);
  }

  else if (command === '/moza-tickets') {
    const { data: tickets } = await supabase.from('moza_data')
      .select('content, metadata')
      .eq('type', 'ticket')
      .eq('metadata->>status', 'escalated');
      
    if (!tickets || tickets.length === 0) {
      await sendEphemeralResponse(env.SLACK_BOT_TOKEN, userId, "Zuup! No escalated tickets right now! You're all caught up.");
      return;
    }

    let msg = "🚨 *Escalated Tickets:*\n\n";
    tickets.forEach(t => {
      msg += `- "${t.content}" (Thread: ${t.metadata.thread_ts})\n`;
    });

    await sendEphemeralResponse(env.SLACK_BOT_TOKEN, userId, msg);
  }
}

async function handleInteractivity(payload: any, env: Bindings) {
  const action = payload.actions[0];
  const channelId = payload.channel.id;
  const threadTs = payload.message.thread_ts;
  const user = payload.user.id;

  if (action.action_id === 'escalate_ticket') {
    const ticketId = action.value;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    // Update ticket
    await supabase.from('moza_data').update({
      metadata: { status: 'escalated', channel_id: channelId, thread_ts: threadTs }
    }).eq('id', ticketId);

    // We assume the Admin needs to be notified. The bot tags the admin group or user
    // Ideally Admin ID should be fetched from roles or env, here we'll just say "Admin"
    await postSlackMessage(env.SLACK_BOT_TOKEN, channelId, threadTs, 
      `Zuup! <@${user}> escalated this ticket! Pinging the big boss!`
    );
  }
}

async function postSlackMessage(token: string, channel: string, thread_ts: string, text: string, blocks?: any) {
  if (!token) return;
  const body: any = { channel, text, thread_ts };
  if (blocks) body.blocks = blocks;

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function sendEphemeralResponse(token: string, user: string, text: string) {
  // Since we use background execution, we might need to send a DM or chat.postEphemeral
  // We'll DM the user the result of their command for simplicity
  if (!token) return;
  
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: user,
      text: text
    })
  });
}

async function handleBulkIngest(messages: string[], env: Bindings) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  
  for (const text of messages) {
    try {
      // 1. Generate Embedding
      const { data: embeddings } = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
      const vector = embeddings[0];

      // 2. Store in Supabase
      await supabase.from('moza_data').insert({
        type: 'knowledge',
        content: text,
        metadata: { source: 'slack_export', answer: 'Inferred from context' },
        embedding: vector
      });
    } catch (e) {
      console.error("Failed to ingest message:", text, e);
    }
  }
}

export default app;
