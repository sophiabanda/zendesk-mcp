import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZendeskClient } from "../clients/zendesk.js";

export function registerCustomerInfo(server: McpServer, zendesk: ZendeskClient) {
  server.registerTool(
    "get_customer_context",
    {
      title: "get_customer_context",
      description:
        "Pull together everything known about a customer: their org, past tickets, and prior reported issues. " +
        "Use this before responding to a ticket to understand history and avoid repeating past answers.",
      inputSchema: {
        requesterEmail: z.string().email().describe("Email address of the customer/requester"),
      },
    },
    async ({ requesterEmail }) => {
      const { results: tickets } = await zendesk.searchTicketsByRequester(requesterEmail);

      let orgSummary = "No organization on file.";
      const orgId = tickets.find((t) => t.organization_id)?.organization_id;
      if (orgId) {
        try {
          const { organization } = await zendesk.getOrganization(orgId);
          orgSummary = `${organization.name} (org #${organization.id})` +
            (organization.tags.length ? `, tags: ${organization.tags.join(", ")}` : "");
        } catch {
          orgSummary = `Organization #${orgId} (details unavailable)`;
        }
      }

      const lines: string[] = [];
      lines.push(`## Customer: ${requesterEmail}`);
      lines.push(`Organization: ${orgSummary}`);
      lines.push(`Total tickets on file: ${tickets.length}`);
      lines.push("");
      lines.push("## Ticket history (most recent first)");
      const sorted = [...tickets].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      for (const t of sorted.slice(0, 15)) {
        lines.push(`- #${t.id} [${t.status}] ${t.subject} — updated ${t.updated_at}, tags: ${t.tags.join(", ") || "none"}`);
      }
      if (sorted.length === 0) {
        lines.push("No prior tickets found for this requester.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
