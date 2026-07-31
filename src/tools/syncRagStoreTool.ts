import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZendeskClient } from "../clients/zendesk.js";
import { syncRagStore } from "../ingest/syncRagStore.js";

export function registerSyncRagStore(server: McpServer, zendesk: ZendeskClient) {
  server.registerTool(
    "sync_rag_store",
    {
      title: "Sync RAG store",
      description:
        "Pull Zendesk tickets updated since the last sync and upsert them into the local RAG vector store, " +
        "so semantic search stays current without re-pulling the full multi-hour export. Safe to run any time; " +
        "only processes what changed since the last run.",
      inputSchema: {},
    },
    async () => {
      const dbPath = process.env.VECTOR_DB_PATH;
      if (!dbPath) {
        return { content: [{ type: "text", text: "VECTOR_DB_PATH is not set (see .env.example)." }], isError: true };
      }
      const result = await syncRagStore(zendesk, dbPath);
      const text =
        `Since ${result.since}: found ${result.ticketsFound} ticket(s), synced ${result.itemsSynced} item(s), ` +
        `${result.messagesSynced} message(s), ${result.chunksSynced} chunk(s). Watermark advanced to ${result.watermark}.`;
      return { content: [{ type: "text", text }] };
    }
  );
}
