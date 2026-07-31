# zendesk-mcp

A custom MCP (Model Context Protocol) server for Zendesk support workflows, built with Node + TypeScript
and the official `@modelcontextprotocol/sdk`.

## What it does

Exposes five tools that Claude (or any MCP client) can call:

| Tool | Purpose |
|---|---|
| `search_similar_tickets` | Semantic search (via an external vector index) + live Zendesk keyword search for similar past issues |
| `get_customer_context` | Pull a customer's org + full ticket history before responding |
| `assess_solutions_by_version` | Find past fixes for an issue and check if they apply to the customer's version |
| `summarize_daily_work` | Roll up a day's Zendesk activity: tickets touched, by status, high-priority follow-ups |
| `sync_rag_store` | Incrementally pull Zendesk tickets updated since the last run and upsert them into the local RAG vector store |

## Tool reference

Each tool's parameters are defined by its `inputSchema` in `src/tools/*.ts` — that file is the source of truth if this
table drifts. Params are passed as a JSON object matching the schema below.

| Tool | Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|---|
| `search_similar_tickets` | `issue` | string | yes | — | Description of the issue/symptom to search for |
| | `topK` | integer (1-20) | no | `5` | Max number of similar past tickets to return |
| `get_customer_context` | `requesterEmail` | string (email) | one of `requesterEmail`/`organization` required | — | Single customer/requester email address |
| | `organization` | string | one of `requesterEmail`/`organization` required | — | Customer organization name, e.g. `"Anthology"` — pulls tickets for the whole account instead of one contact |
| `assess_solutions_by_version` | `issue` | string | yes | — | Issue description to search past solutions for |
| | `customerVersion` | string | yes | — | Customer's current product version, e.g. `"8.2.0"` |
| | `topK` | integer (1-20) | no | `5` | Max number of past-solution matches to consider |
| `summarize_daily_work` | `date` | string (`YYYY-MM-DD`) | no | today | Day to summarize |
| | `assignee` | string (email) | no | `ZENDESK_EMAIL` from `.env` | Scopes results to this assignee; defaults to you |
| `sync_rag_store` | — | (no parameters) | — | — | Safe to run any time; only processes tickets updated since the last sync |

### Calling a tool through Claude

Describe what you want in plain language — Claude fills in the parameters:

```
Run summarize_daily_work for 2026-07-20
Search similar tickets for "PDF export hangs on large files", top 10
Get customer context for jane@example.com
Get customer context for the organization Anthology
```

### Calling a tool via raw MCP JSON-RPC

This is the `tools/call` request the client actually sends (see `test-client.mjs` for a working example):

```json
{
  "method": "tools/call",
  "params": {
    "name": "summarize_daily_work",
    "arguments": {
      "date": "2026-07-20",
      "assignee": "sophia.banda@nutrient.io"
    }
  }
}
```

Omit any optional argument to fall back to its default (e.g. omit `date` for "today", omit `assignee` to scope to
`ZENDESK_EMAIL`).

### Calling a tool from a plain terminal (no Claude Code needed)

The server is just a Node process speaking MCP over stdio — any MCP client can talk to it, including a terminal
script. Use `run.mjs` (loads your real `.env`, unlike `test-client.mjs` which uses fake credentials for smoke
testing):

```bash
node run.mjs <tool_name> '<json_args>'

# examples
node run.mjs get_customer_context '{"organization":"Anthology"}'
node run.mjs get_customer_context '{"requesterEmail":"jane@example.com"}'
node run.mjs summarize_daily_work '{"date":"2026-07-20"}'
node run.mjs search_similar_tickets '{"issue":"PDF export hangs on large files","topK":10}'
node run.mjs sync_rag_store '{}'
```

Run `npm run build` first if you've made source changes — this calls the compiled server in `build/`, not the
TypeScript source directly.

### Syncing the RAG store

The `lancedb` vector DB provider (see Setup below) is a local, file-based store extracted from a one-time export.
To keep it current without re-pulling that full export, run the incremental sync whenever you want — it only
processes Zendesk tickets updated since the last run (tracked in `data/rag-store/.sync-state.json`):

```bash
npm run sync-rag
# or, equivalently, via the MCP tool:
node run.mjs sync_rag_store '{}'
```

## How it's put together

```
src/
  clients/
    zendesk.ts     – thin wrapper over the Zendesk REST API (search, tickets, users, orgs)
    vectorDb.ts     – adapter interface (VectorDb) + a mock implementation + a generic HTTP
                      implementation + a lancedb implementation, so the real backend can be
                      swapped in via .env only
    embedder.ts     – shared embedding model (Xenova/all-MiniLM-L6-v2) used by both the
                      lancedb query path and the ingestion pipeline, so vectors stay comparable
  ingest/
    syncRagStore.ts – incremental sync: fetch changed tickets, embed, upsert into LanceDB
    cli.ts          – thin CLI wrapper around syncRagStore.ts (`npm run sync-rag`)
  tools/
    searchSimilarTickets.ts
    customerInfo.ts
    assessSolutions.ts
    dailySummary.ts
    syncRagStoreTool.ts
  index.ts          – wires everything together and starts the server over stdio
test-client.mjs      – a tiny MCP client used to sanity-check the server without wiring it into Claude
```

### Why the adapter pattern for the vector DB

The exact shape of the backing RAG index isn't fixed yet. Rather than hard-coding a client, `vectorDb.ts` defines
a one-method interface:

```ts
interface VectorDb {
  search(query: string, topK?: number): Promise<VectorMatch[]>;
}
```

Everything else in the codebase (the tools) only depends on that interface, not on a specific backend.
`VECTOR_DB_PROVIDER=mock` in `.env` gives a fake in-memory index for building and testing end-to-end. Once the
real index's API is known:
- use the built-in `HttpVectorDb` if there's a query endpoint in front of it (adjust the request/response shape
  in `vectorDb.ts` to match the actual API), or
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
- `VECTOR_DB_PROVIDER` — `mock` to start; `lancedb` once you have the real store extracted locally (see below); switch
  to something else once you have other real connection info.
- `VECTOR_DB_PATH` — only used by the `lancedb` provider. Path to the extracted LanceDB store, e.g.
  `./data/rag-store/store`. The store itself is a one-time export from a coworker (an AES-encrypted zip — get the
  password from them directly, never paste it into chat) extracted into `data/rag-store/` (gitignored). Once
  extracted, keep it current with `npm run sync-rag` — see "Syncing the RAG store" above.

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

## Notes / open items

(Internal notes — may be stale, keep or prune as they're resolved.)

1. The real vector index's query interface isn't confirmed yet (REST endpoint? Python service? direct DB
   connection to Pinecone/Qdrant/pgvector/etc). That determines whether `HttpVectorDb` works as-is, needs
   tweaking, or a new adapter class is needed.
2. Once wired to the real index, revisit the `metadata` shape `assess_solutions_by_version` expects
   (`fixedInVersion`, `product`, `tags`) — align it with whatever fields the index actually stores per chunk.
3. Consider adding a `list_products` or `list_versions` tool if there's a canonical version list to validate
   `customerVersion` against.
4. Add tests (e.g. with `node --test`) for `compareVersions` in `assessSolutions.ts` — it's a naive semver
   comparator and worth hardening for versions like `8.4.2-rc1`.
