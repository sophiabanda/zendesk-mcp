// Generic CLI for calling any zendesk-mcp tool from the terminal, without an MCP client like Claude Code.
// Usage: node run.mjs <tool_name> '<json_args>'
// Example: node run.mjs get_customer_context '{"organization":"Anthology"}'

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [toolName, jsonArgs] = process.argv.slice(2);

if (!toolName) {
  console.error("Usage: node run.mjs <tool_name> '<json_args>'");
  console.error(`Example: node run.mjs get_customer_context '{"organization":"Anthology"}'`);
  process.exit(1);
}

let args = {};
if (jsonArgs) {
  try {
    args = JSON.parse(jsonArgs);
  } catch (err) {
    console.error("Could not parse json_args as JSON:", err.message);
    process.exit(1);
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  // Real .env is loaded by build/index.js itself (via dotenv/config); no env overrides needed here.
});

const client = new Client({ name: "call-tool-cli", version: "0.1.0" });
await client.connect(transport);

try {
  const result = await client.callTool({ name: toolName, arguments: args });
  for (const item of result.content) {
    if (item.type === "text") console.log(item.text);
  }
} finally {
  await client.close();
}
