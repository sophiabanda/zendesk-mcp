import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZendeskClient } from "../clients/zendesk.js";

export function registerDailySummary(server: McpServer, zendesk: ZendeskClient) {
  server.registerTool(
    "summarize_daily_work",
    {
      title: "summarize_daily_work",
      description:
        "Summarize Zendesk activity for a given day (default: today) — tickets touched, solved, still open, " +
        "and any high-priority items needing follow-up. Ask for this at end of day or during standup prep.",
      inputSchema: {
        date: z.string().optional().describe("ISO date (YYYY-MM-DD) to summarize; defaults to today"),
        assignee: z
          .string()
          .optional()
          .describe("Assignee email to scope the summary to; defaults to ZENDESK_EMAIL (you)"),
      },
    },
    async ({ date, assignee }) => {
      const isoDate = date ?? new Date().toISOString().slice(0, 10);
      const scopedAssignee = assignee ?? process.env.ZENDESK_EMAIL;
      const { results: tickets } = await zendesk.ticketsUpdatedSince(isoDate, { assignee: scopedAssignee });

      const byStatus: Record<string, number> = {};
      const highPriority: typeof tickets = [];
      for (const t of tickets) {
        byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        if (t.priority === "urgent" || t.priority === "high") highPriority.push(t);
      }

      const lines: string[] = [];
      lines.push(`## Zendesk activity summary — ${isoDate}`);
      lines.push(`Total tickets touched: ${tickets.length}`);
      lines.push(`By status: ${Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join(", ") || "none"}`);
      lines.push("");
      lines.push(`## High-priority / needs follow-up (${highPriority.length})`);
      if (highPriority.length === 0) {
        lines.push("None.");
      } else {
        for (const t of highPriority) {
          lines.push(`- #${t.id} [${t.priority}/${t.status}] ${t.subject}`);
        }
      }
      lines.push("");
      lines.push(`## Full list`);
      for (const t of tickets) {
        lines.push(`- #${t.id} [${t.status}] ${t.subject} (updated ${t.updated_at})`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
