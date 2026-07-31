import { embedText } from "./embedder.js";

/**
 * Adapter over your coworker's RAG vector database of Zendesk history.
 *
 * We don't yet know how his index is exposed, so this defines a small
 * interface (`VectorDb`) that every backend implements, plus:
 *   - a `mock` implementation for local development/testing
 *   - an `http` implementation for the common case where he put a query
 *     endpoint in front of it (adjust request/response shape once you
 *     see his actual API)
 *
 * Swap providers via VECTOR_DB_PROVIDER in .env — nothing else in the
 * codebase needs to change.
 */

export interface VectorMatch {
  /** Zendesk ticket ID this chunk came from, if known. */
  ticketId?: number;
  /** The text chunk that matched (e.g. a comment, resolution note, subject+description). */
  text: string;
  /** Similarity score, 0-1, higher = closer match. */
  score: number;
  /** Arbitrary metadata your coworker's index stores per chunk (product, version, tags, etc). */
  metadata?: Record<string, unknown>;
}

export interface VectorDb {
  /** Return the top-K chunks most semantically similar to `query`. */
  search(query: string, topK?: number): Promise<VectorMatch[]>;
}

/** In-memory fake so you can build/test tools before the real index is wired in. */
export class MockVectorDb implements VectorDb {
  private sample: VectorMatch[] = [
    {
      ticketId: 10234,
      text: "Customer reported PDF export hangs on files >200 pages. Root cause: font subsetting loop. Fixed in Core SDK 8.4.2.",
      score: 0.91,
      metadata: { product: "Core SDK", fixedInVersion: "8.4.2", tags: ["pdf-export", "performance"] },
    },
    {
      ticketId: 9981,
      text: "Annotation toolbar not rendering in Safari 17. Workaround: disable hardware acceleration flag. Permanent fix shipped in Web SDK 7.1.0.",
      score: 0.84,
      metadata: { product: "Web SDK", fixedInVersion: "7.1.0", tags: ["safari", "annotations", "rendering"] },
    },
  ];

  async search(query: string, topK = 5): Promise<VectorMatch[]> {
    // naive keyword overlap as a stand-in for real embedding similarity
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    return this.sample
      .map((m) => {
        const hits = terms.filter((t) => m.text.toLowerCase().includes(t)).length;
        return { ...m, score: hits / Math.max(terms.length, 1) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/** Generic HTTP-backed vector DB — point it at whatever query endpoint your coworker exposes. */
export class HttpVectorDb implements VectorDb {
  constructor(private url: string, private apiKey?: string) {}

  async search(query: string, topK = 5): Promise<VectorMatch[]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ query, top_k: topK }),
    });
    if (!res.ok) {
      throw new Error(`Vector DB error ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as { matches?: VectorMatch[] };
    // TODO: reshape this once you see the real response format from his API
    return data.matches ?? [];
  }
}

/**
 * Embedded LanceDB store, extracted from a coworker's periodic export
 * (see data/rag-store/README or project memory for extraction details).
 *
 * Query text must be embedded with the SAME model used to build the
 * `chunks` table, or similarity scores are meaningless:
 *   model: Xenova/all-MiniLM-L6-v2 (ONNX port of sentence-transformers/all-MiniLM-L6-v2)
 *   library: @huggingface/transformers 3.8.1, FP32, mean pooling, L2-normalized, 384 dims
 */
export class LanceVectorDb implements VectorDb {
  private tablePromise: Promise<import("@lancedb/lancedb").Table>;

  constructor(private dbPath: string) {
    this.tablePromise = (async () => {
      const lancedb = await import("@lancedb/lancedb");
      const db = await lancedb.connect(this.dbPath);
      return db.openTable("chunks");
    })();
  }

  async search(query: string, topK = 5): Promise<VectorMatch[]> {
    const [table, vector] = await Promise.all([this.tablePromise, embedText(query)]);
    const rows = await table.search(vector).limit(topK).toArray();
    return rows.map((row) => ({
      ticketId: typeof row.item_uid === "string" ? parseZendeskTicketId(row.item_uid) : undefined,
      text: row.text as string,
      // LanceDB returns L2 distance for normalized vectors; convert to a 0-1 similarity score.
      score: 1 - Math.min(Math.max(row._distance as number, 0), 2) / 2,
      metadata: {
        source: row.source,
        projectOrPlatform: row.project_or_platform,
        customerName: row.customer_name,
        section: row.section,
        createdAt: row.created_at,
      },
    }));
  }
}

function parseZendeskTicketId(itemUid: string): number | undefined {
  const match = /^zendesk:(\d+)$/.exec(itemUid);
  return match ? Number(match[1]) : undefined;
}

export function vectorDbFromEnv(): VectorDb {
  const provider = process.env.VECTOR_DB_PROVIDER ?? "mock";
  switch (provider) {
    case "mock":
      return new MockVectorDb();
    case "http":
      if (!process.env.VECTOR_DB_URL) throw new Error("VECTOR_DB_URL required for http provider");
      return new HttpVectorDb(process.env.VECTOR_DB_URL, process.env.VECTOR_DB_API_KEY);
    case "lancedb":
      if (!process.env.VECTOR_DB_PATH) throw new Error("VECTOR_DB_PATH required for lancedb provider");
      return new LanceVectorDb(process.env.VECTOR_DB_PATH);
    // Add cases here as you learn his stack, e.g.:
    // case "pinecone": return new PineconeVectorDb(...)
    // case "qdrant": return new QdrantVectorDb(...)
    default:
      throw new Error(`Unknown VECTOR_DB_PROVIDER: ${provider}`);
  }
}
