import "dotenv/config";
import { zendeskClientFromEnv } from "../clients/zendesk.js";
import { syncRagStore } from "./syncRagStore.js";

async function main() {
  const dbPath = process.env.VECTOR_DB_PATH;
  if (!dbPath) throw new Error("VECTOR_DB_PATH required (see .env.example)");

  const zendesk = zendeskClientFromEnv();
  console.log(`Syncing RAG store at ${dbPath}...`);
  const result = await syncRagStore(zendesk, dbPath);
  console.log(
    `Since ${result.since}: found ${result.ticketsFound} ticket(s), synced ${result.itemsSynced} item(s), ` +
      `${result.messagesSynced} message(s), ${result.chunksSynced} chunk(s). Watermark advanced to ${result.watermark}.`
  );
}

main().catch((err) => {
  console.error("RAG store sync failed:", err);
  process.exit(1);
});
