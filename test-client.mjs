import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: {
    ZENDESK_SUBDOMAIN: "fake",
    ZENDESK_EMAIL: "fake@example.com",
    ZENDESK_API_TOKEN: "fake",
    VECTOR_DB_PROVIDER: "mock",
  },
});

const client = new Client({ name: "test-client", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools registered:", tools.tools.map((t) => t.name));

const result = await client.callTool({
  name: "assess_solutions_by_version",
  arguments: { issue: "PDF export hangs on large files", customerVersion: "8.2.0" },
});
console.log("\n--- assess_solutions_by_version result ---");
console.log(result.content[0].text);

await client.close();
