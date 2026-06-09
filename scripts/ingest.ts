import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const WORKER_URL = 'https://moza-help-bot.zuup.workers.dev'; // Replace if needed
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-your-token-here';
const BATCH_SIZE = 10; // Process 10 messages at a time
const DELAY_MS = 2000; // 2 seconds between batches

const exportDir = process.argv.slice(2).join(' ');

if (!exportDir) {
  console.error("Usage: ts-node scripts/ingest.ts <path_to_slack_export_folder>");
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
  const userMessages = messages
    .filter((m: any) => m.type === 'message' && !m.subtype && typeof m.text === 'string' && m.text.length > 10)
    .map((m: any) => m.text);

  if (userMessages.length === 0) return;

  for (let i = 0; i < userMessages.length; i += BATCH_SIZE) {
    const batch = userMessages.slice(i, i + BATCH_SIZE);
    console.log(`Sending batch of ${batch.length} messages to Moza...`);

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
