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
        "Look up by requester email for a single contact, or by organization name for the whole account. " +
        "Use this before responding to a ticket to understand history and avoid repeating past answers.",
      inputSchema: {
        requesterEmail: z.string().email().optional().describe("Email address of the customer/requester"),
        organization: z
          .string()
          .optional()
          .describe("Customer organization name to search by, e.g. 'Anthology'. Use instead of requesterEmail to pull the whole account's tickets."),
      },
    },
    async ({ requesterEmail, organization }) => {
      if (!requesterEmail && !organization) {
        return {
          content: [{ type: "text", text: "Provide either requesterEmail or organization." }],
        };
      }

      const { results: tickets } = organization
        ? await zendesk.searchTicketsByOrganization(organization)
        : await zendesk.searchTicketsByRequester(requesterEmail!);

      const label = organization ? `organization "${organization}"` : requesterEmail!;

      let orgSummary = "No organization on file.";
      const orgId = tickets.find((t) => t.organization_id)?.organization_id;
      if (orgId) {
        try {
          const { organization: org } = await zendesk.getOrganization(orgId);
          orgSummary = `${org.name} (org #${org.id})` +
            (org.tags.length ? `, tags: ${org.tags.join(", ")}` : "");
        } catch {
          orgSummary = `Organization #${orgId} (details unavailable)`;
        }
      }

      const lines: string[] = [];
      lines.push(`## Customer: ${label}`);
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
