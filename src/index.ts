import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { zendeskClientFromEnv } from "./clients/zendesk.js";
import { vectorDbFromEnv } from "./clients/vectorDb.js";
import { registerSearchSimilarTickets } from "./tools/searchSimilarTickets.js";
import { registerCustomerInfo } from "./tools/customerInfo.js";
import { registerAssessSolutions } from "./tools/assessSolutions.js";
import { registerDailySummary } from "./tools/dailySummary.js";

async function main() {
  const zendesk = zendeskClientFromEnv();
  const vectorDb = vectorDbFromEnv();

  const server = new McpServer({
    name: "zendesk-mcp",
    version: "0.1.0",
  });

  registerSearchSimilarTickets(server, zendesk, vectorDb);
  registerCustomerInfo(server, zendesk);
  registerAssessSolutions(server, vectorDb);
  registerDailySummary(server, zendesk);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("zendesk-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting zendesk-mcp:", err);
  process.exit(1);
});
