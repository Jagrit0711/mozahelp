import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const WORKER_URL = 'https://moza-help-bot.zuup.workers.dev'; // Replace if needed
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-your-token-here';
const BATCH_SIZE = 10; // Process 10 messages at a time
const DELAY_MS = 2000; // 2 seconds between batches

const args = process.argv.slice(2);
const wipeFlag = args.includes('--wipe');
const exportDir = args.filter(a => a !== '--wipe').join(' ');

if (!exportDir) {
  console.error("Usage: ts-node scripts/ingest.ts [--wipe] <path_to_slack_export_folder>");
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processFile(filePath: string) {
  console.log(`Processing file: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf8');
  let messages;
  try {
    messages = JSON.parse(content);
  } catch (e) {
    console.error(`Invalid JSON in ${filePath}`);
    return;
  }

  if (!Array.isArray(messages)) return;

  // Filter out system messages, only keep real human messages with text
  const validMessages = messages.filter((m: any) => m.type === 'message' && !m.subtype && typeof m.text === 'string' && m.text.length > 5);

  if (validMessages.length === 0) return;

  const CHUNK_SIZE = 10;
  const STEP_SIZE = 5; // Overlap chunks to prevent cutting conversations in half
  const chunks: string[] = [];

  for (let i = 0; i < validMessages.length; i += STEP_SIZE) {
    const chunkMsgs = validMessages.slice(i, i + CHUNK_SIZE);
    const chunkText = chunkMsgs.map((m: any) => `User: ${m.text}`).join('\n\n');
    chunks.push(chunkText);
    if (i + CHUNK_SIZE >= validMessages.length) break;
  }

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    console.log(`Sending batch of ${batch.length} conversational chunks to Moza...`);

    try {
      const res = await fetch(`${WORKER_URL}/slack/ingest-batch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messages: batch })
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`Error sending batch: ${res.status} ${text}`);
      }
    } catch (e) {
      console.error(`Network error:`, e);
    }

    await sleep(DELAY_MS);
  }
}

async function main() {
  if (wipeFlag) {
    console.log("🧹 Wiping old memories from Moza database...");
    try {
      const res = await fetch(`${WORKER_URL}/slack/wipe-knowledge`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
      });
      if (res.ok) console.log("✅ Database wiped successfully!");
      else console.error("❌ Failed to wipe database:", await res.text());
    } catch (e) {
      console.error("❌ Network error wiping database:", e);
    }
    await sleep(2000);
  }

  const stat = fs.statSync(exportDir);
  if (stat.isDirectory()) {
    // Recursively find all .json files
    function getAllJsonFiles(dir: string, fileList: string[] = []) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
          getAllJsonFiles(filePath, fileList);
        } else if (filePath.endsWith('.json')) {
          fileList.push(filePath);
        }
      }
      return fileList;
    }

    const allFiles = getAllJsonFiles(exportDir);
    for (const file of allFiles) {
      await processFile(file);
    }
  } else {
    await processFile(exportDir);
  }

  console.log("✅ Finished uploading brain data to Moza!");
}

main();
