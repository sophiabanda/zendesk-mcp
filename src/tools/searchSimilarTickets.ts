import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZendeskClient } from "../clients/zendesk.js";
import type { VectorDb } from "../clients/vectorDb.js";

export function registerSearchSimilarTickets(server: McpServer, zendesk: ZendeskClient, vectorDb: VectorDb) {
  server.registerTool(
    "search_similar_tickets",
    {
      title: "Search similar tickets",
      description:
        "Find past Zendesk tickets similar to a described issue, using semantic search over ticket history " +
        "plus a live Zendesk keyword search. Use this before triaging a new ticket to check for precedent.",
      inputSchema: {
        issue: z.string().describe("Description of the issue or symptom to search for, e.g. 'PDF export hangs on large files'"),
        topK: z.number().int().min(1).max(20).default(5).describe("Max number of similar past tickets to return"),
      },
    },
    async ({ issue, topK }) => {
      const [semanticMatches, keywordResults] = await Promise.all([
        vectorDb.search(issue, topK),
        zendesk.searchTickets(issue).catch(() => ({ results: [], count: 0 })),
      ]);

      const lines: string[] = [];
      lines.push(`## Semantic matches (vector search) for: "${issue}"`);
      if (semanticMatches.length === 0) {
        lines.push("No semantic matches found.");
      } else {
        for (const m of semanticMatches) {
          lines.push(
            `- score ${m.score.toFixed(2)} | ticket #${m.ticketId ?? "?"} | ${m.text}` +
              (m.metadata ? ` | metadata: ${JSON.stringify(m.metadata)}` : "")
          );
        }
      }

      lines.push("");
      lines.push(`## Live Zendesk keyword search results`);
      if (keywordResults.results.length === 0) {
        lines.push("No matching tickets found via Zendesk search.");
      } else {
        for (const t of keywordResults.results.slice(0, topK)) {
          lines.push(`- #${t.id} [${t.status}] ${t.subject} (updated ${t.updated_at})`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
