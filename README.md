# zendesk-mcp

A custom MCP (Model Context Protocol) server for Zendesk support workflows, built with Node + TypeScript
and the official `@modelcontextprotocol/sdk`.

## What it does

Exposes four tools that Claude (or any MCP client) can call:

| Tool | Purpose |
|---|---|
| `search_similar_tickets` | Semantic search (via your coworker's vector index) + live Zendesk keyword search for similar past issues |
| `get_customer_context` | Pull a customer's org + full ticket history before responding |
| `assess_solutions_by_version` | Find past fixes for an issue and check if they apply to the customer's version |
| `summarize_daily_work` | Roll up a day's Zendesk activity: tickets touched, by status, high-priority follow-ups |

## How it's put together

```
src/
  clients/
    zendesk.ts     – thin wrapper over the Zendesk REST API (search, tickets, users, orgs)
    vectorDb.ts     – adapter interface (VectorDb) + a mock implementation + a generic HTTP
                      implementation, so the real backend can be swapped in via .env only
  tools/
    searchSimilarTickets.ts
    customerInfo.ts
    assessSolutions.ts
    dailySummary.ts
  index.ts          – wires everything together and starts the server over stdio
test-client.mjs      – a tiny MCP client used to sanity-check the server without wiring it into Claude
```

### Why the adapter pattern for the vector DB

You don't yet know exactly how your coworker's RAG index is exposed. Rather than hard-coding a client, `vectorDb.ts`
defines a one-method interface:

```ts
interface VectorDb {
  search(query: string, topK?: number): Promise<VectorMatch[]>;
}
```

Everything else in the codebase (the tools) only depends on that interface, not on a specific backend. Today
`VECTOR_DB_PROVIDER=mock` in `.env` gives you a fake in-memory index so you can build and test end-to-end.
Once you know his API, you either:
- use the built-in `HttpVectorDb` if he put a query endpoint in front of it (adjust the request/response shape
  in `vectorDb.ts` to match his actual API), or
- add a new class (e.g. `PineconeVectorDb`, `QdrantVectorDb`) implementing the same interface, and add a case
  for it in `vectorDbFromEnv()`.

No changes needed anywhere else.

## Setup

```bash
npm install
cp .env.example .env   # fill in your Zendesk subdomain/email/API token
npm run build
```

`.env` fields:
- `ZENDESK_SUBDOMAIN` / `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` — from Zendesk Admin Center > Apps and integrations > APIs > Zendesk API. Generate a token there and enable token access.
- `VECTOR_DB_PROVIDER` — `mock` to start; switch once you have real connection info.

## Running it standalone (for testing)

```bash
node test-client.mjs
```

This spawns the built server, lists its tools, and calls `assess_solutions_by_version` against the mock vector
data — useful for iterating without wiring the server into an actual MCP client.

## Registering it with Claude

Add it to your MCP client config (e.g. Claude Desktop's `claude_desktop_config.json`, or Claude Code's
`.mcp.json`):

```json
{
  "mcpServers": {
    "zendesk-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/zendesk-mcp/build/index.js"],
      "env": {
        "ZENDESK_SUBDOMAIN": "your-company",
        "ZENDESK_EMAIL": "you@company.com",
        "ZENDESK_API_TOKEN": "...",
        "VECTOR_DB_PROVIDER": "mock"
      }
    }
  }
}
```

## Next steps

1. Ask your coworker exactly how his vector index is queryable (REST endpoint? Python service? direct DB
   connection to Pinecone/Qdrant/pgvector/etc). That determines whether you use `HttpVectorDb` as-is, tweak it,
   or write a new adapter class.
2. Once wired to the real index, revisit the `metadata` shape `assess_solutions_by_version` expects
   (`fixedInVersion`, `product`, `tags`) — align it with whatever fields his index actually stores per chunk.
3. Consider adding a `list_products` or `list_versions` tool if there's a canonical version list to validate
   `customerVersion` against.
4. Add tests (e.g. with `node --test`) for `compareVersions` in `assessSolutions.ts` — it's a naive semver
   comparator and worth hardening if you start seeing versions like `8.4.2-rc1`.
