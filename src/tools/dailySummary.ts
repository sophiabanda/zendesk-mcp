import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZendeskClient } from "../clients/zendesk.js";

function truncate(text: string, maxLen = 600): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

export function registerDailySummary(server: McpServer, zendesk: ZendeskClient) {
  server.registerTool(
    "summarize_daily_work",
    {
      title: "summarize_daily_work",
      description:
        "Gather Zendesk activity data for a given day (default: today) — tickets touched, solved, still open, " +
        "and any high-priority items needing follow-up — and write a short prose summary from it. Ask for this " +
        "at end of day or during standup prep.",
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
      const nextDay = new Date(`${isoDate}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const before = nextDay.toISOString().slice(0, 10);
      const scopedAssignee = assignee ?? process.env.ZENDESK_EMAIL;
      const { results: candidates } = await zendesk.ticketsUpdatedSince(isoDate, { assignee: scopedAssignee, before });
      const me = scopedAssignee ? await zendesk.getUserByEmail(scopedAssignee) : null;

      const windowStart = new Date(`${isoDate}T00:00:00Z`);
      const windowEnd = new Date(`${before}T00:00:00Z`);

      const touched: typeof candidates = [];
      const changedNotByYou: typeof candidates = [];
      const commentsById = new Map<number, Awaited<ReturnType<typeof zendesk.getTicketComments>>["comments"]>();

      for (const t of candidates) {
        let lastComment: { author_id: number; created_at: string; body: string; public: boolean } | undefined;
        try {
          const { comments } = await zendesk.getTicketComments(t.id);
          commentsById.set(t.id, comments);
          lastComment = comments[comments.length - 1];
        } catch {
          // couldn't fetch comments; fall through and treat as changed-not-by-you since we can't confirm authorship
        }

        const commentedByYouInWindow =
          me != null &&
          lastComment != null &&
          lastComment.author_id === me.id &&
          new Date(lastComment.created_at) >= windowStart &&
          new Date(lastComment.created_at) < windowEnd;

        if (commentedByYouInWindow) {
          touched.push(t);
        } else {
          changedNotByYou.push(t);
        }
      }

      const byStatus: Record<string, number> = {};
      const highPriority: typeof candidates = [];
      for (const t of touched) {
        byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        if (t.priority === "urgent" || t.priority === "high") highPriority.push(t);
      }

      const renderTicket = (t: (typeof candidates)[number]) => {
        const lines: string[] = [];
        lines.push(`- #${t.id} [${t.priority ?? "normal"}/${t.status}] ${t.subject} (updated ${t.updated_at})`);
        if (t.description) {
          lines.push(`  Description: ${truncate(t.description)}`);
        }
        const comments = commentsById.get(t.id);
        if (comments === undefined) {
          lines.push(`  Activity: (couldn't fetch comments)`);
        } else {
          const inWindow = comments.filter(
            (c) => new Date(c.created_at) >= windowStart && new Date(c.created_at) < windowEnd
          );
          const toShow = inWindow.length > 0 ? inWindow : comments.slice(-1);
          for (const c of toShow) {
            const author = c.public ? "public reply" : "internal note";
            lines.push(`  [${c.created_at}] (${author}): ${truncate(c.body)}`);
          }
        }
        return lines;
      };

      const lines: string[] = [];
      lines.push(
        "Instructions: the sections below are raw Zendesk data, not a finished summary. Using it, write a short " +
          "prose daily summary covering what got done, recurring themes across tickets, any blockers, and what " +
          "needs attention next — don't just restate the raw list. The stats below are precomputed and safe to " +
          "quote directly; use the per-ticket activity text to inform your own synthesis rather than repeating it verbatim."
      );
      lines.push("");
      lines.push(`## Zendesk activity summary — ${isoDate}`);
      lines.push(`Total tickets touched: ${touched.length}`);
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
      lines.push(`## Full list — tickets you commented on today`);
      if (touched.length === 0) {
        lines.push("None.");
      } else {
        for (const t of touched) lines.push(...renderTicket(t));
      }
      lines.push("");
      lines.push(
        `## Changed today but not by you (${changedNotByYou.length}) — status/automation updates, or comments from other agents`
      );
      if (changedNotByYou.length === 0) {
        lines.push("None.");
      } else {
        for (const t of changedNotByYou) lines.push(...renderTicket(t));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
