import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VectorDb } from "../clients/vectorDb.js";

/**
 * Very small semver-ish comparator good enough for "is this fix in my version" questions.
 * Handles plain dotted versions like 8.4.2 vs 8.10.0. Falls back to string compare
 * if either version doesn't parse as dotted numbers.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a.localeCompare(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function registerAssessSolutions(server: McpServer, vectorDb: VectorDb) {
  server.registerTool(
    "assess_solutions_by_version",
    {
      title: "assess_solutions_by_version",
      description:
        "Search past solutions/workarounds for an issue and check whether each fix applies to a given product version. " +
        "Use this to figure out if a known fix should already cover the customer's version, or if they need to upgrade.",
      inputSchema: {
        issue: z.string().describe("Issue description to search past solutions for"),
        customerVersion: z.string().describe("The product version the customer is currently running, e.g. '8.2.0'"),
        topK: z.number().int().min(1).max(20).default(5),
      },
    },
    async ({ issue, customerVersion, topK }) => {
      const matches = await vectorDb.search(issue, topK);

      const lines: string[] = [];
      lines.push(`## Past solutions for "${issue}" vs. customer version ${customerVersion}`);
      if (matches.length === 0) {
        lines.push("No past solutions found for this issue.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      for (const m of matches) {
        const fixedIn = (m.metadata?.fixedInVersion as string | undefined) ?? null;
        let verdict = "Unknown — no version metadata on this record; check the ticket directly.";
        if (fixedIn) {
          const cmp = compareVersions(customerVersion, fixedIn);
          verdict =
            cmp >= 0
              ? `Already fixed — customer's version ${customerVersion} >= fix version ${fixedIn}.`
              : `NOT fixed yet — fix shipped in ${fixedIn}, customer is on ${customerVersion}. Upgrade or apply workaround.`;
        }
        lines.push(
          `- (score ${m.score.toFixed(2)}) ticket #${m.ticketId ?? "?"}: ${m.text}\n  → ${verdict}`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
