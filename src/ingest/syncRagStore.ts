/**
 * Incremental sync: pulls Zendesk tickets updated since the last run and
 * upserts them into the local LanceDB RAG store (items/messages/chunks),
 * instead of re-pulling the coworker's full multi-hour export each time.
 *
 * Watermark is the max `items.updated_at` already in the store (source
 * derived on first run, then persisted to .sync-state.json next to it) so
 * a fresh checkout of the coworker's export "just works" without manual
 * backfill.
 *
 * Usage: node build/ingest/syncRagStore.js  (or the sync_rag_store MCP tool)
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { ZendeskClient, ZendeskTicket } from "../clients/zendesk.js";
import { embedText } from "../clients/embedder.js";

interface SyncState {
  lastSyncedUpdatedAt: string;
}

interface ItemRow {
  uid: string;
  source: string;
  source_id: string;
  project_or_platform: string;
  title: string;
  status: string;
  priority: string;
  customer_name: string;
  customer_arr: number;
  customer_tier: string;
  version: string;
  assignee: string;
  reporter: string;
  organization_id: string;
  comment_count: number;
  attachment_count: number;
  linked_issue_count: number;
  labels_or_tags: string;
  created_at: string;
  updated_at: string;
  url: string;
  raw_json: string;
}

interface MessageRow {
  message_uid: string;
  item_uid: string;
  source: string;
  message_type: string;
  visibility: string;
  author: string;
  created_at: string;
  text: string;
  raw_json: string;
}

interface ChunkRow {
  chunk_uid: string;
  item_uid: string;
  parent_type: string;
  parent_uid: string;
  source: string;
  project_or_platform: string;
  customer_name: string;
  visibility: string;
  section: string;
  created_at: string;
  text: string;
  vector: number[];
}

export interface SyncResult {
  since: string;
  ticketsFound: number;
  itemsSynced: number;
  messagesSynced: number;
  chunksSynced: number;
  watermark: string;
}

function statePath(dbPath: string): string {
  return path.join(dbPath, "..", ".sync-state.json");
}

async function loadState(dbPath: string): Promise<SyncState | null> {
  try {
    return JSON.parse(await readFile(statePath(dbPath), "utf-8"));
  } catch {
    return null;
  }
}

async function saveState(dbPath: string, state: SyncState): Promise<void> {
  await writeFile(statePath(dbPath), JSON.stringify(state, null, 2));
}

/** First run: derive the watermark from what's already in the store, so we don't re-embed the coworker's export. */
async function deriveInitialWatermark(itemsTable: lancedb.Table): Promise<string> {
  const rows = await itemsTable.query().where("source = 'zendesk'").select(["updated_at"]).toArray();
  let max = "1970-01-01T00:00:00Z";
  for (const row of rows) {
    if (typeof row.updated_at === "string" && row.updated_at > max) max = row.updated_at;
  }
  return max;
}

function ticketToItemRow(ticket: ZendeskTicket): ItemRow {
  return {
    uid: `zendesk:${ticket.id}`,
    source: "zendesk",
    source_id: String(ticket.id),
    project_or_platform: "",
    title: ticket.subject,
    status: ticket.status,
    priority: ticket.priority ?? "",
    customer_name: "",
    customer_arr: 0,
    customer_tier: "",
    version: "",
    assignee: "",
    reporter: "",
    organization_id: ticket.organization_id != null ? String(ticket.organization_id) : "",
    comment_count: 0, // filled in by caller once comments are fetched
    attachment_count: 0,
    linked_issue_count: 0,
    labels_or_tags: ticket.tags.join(","),
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    url: "",
    raw_json: JSON.stringify(ticket),
  };
}

async function upsert(table: lancedb.Table, key: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  await table.mergeInsert([key]).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
}

export async function syncRagStore(zendesk: ZendeskClient, dbPath: string): Promise<SyncResult> {
  const db = await lancedb.connect(dbPath);
  const itemsTable = await db.openTable("items");
  const messagesTable = await db.openTable("messages");
  const chunksTable = await db.openTable("chunks");

  const state = await loadState(dbPath);
  const since = state?.lastSyncedUpdatedAt ?? (await deriveInitialWatermark(itemsTable));

  const { results: tickets } = await zendesk.ticketsUpdatedSince(since);

  if (tickets.length === 0) {
    await saveState(dbPath, { lastSyncedUpdatedAt: since });
    return { since, ticketsFound: 0, itemsSynced: 0, messagesSynced: 0, chunksSynced: 0, watermark: since };
  }

  const itemRows: ItemRow[] = [];
  const messageRows: MessageRow[] = [];
  const chunkRows: ChunkRow[] = [];
  let maxUpdatedAt = since;

  for (const ticket of tickets) {
    const { comments } = await zendesk.getTicketComments(ticket.id);
    const itemRow = ticketToItemRow(ticket);
    itemRow.comment_count = comments.length;
    itemRows.push(itemRow);

    const itemUid = itemRow.uid;
    const summaryText = [ticket.subject, ticket.description].filter(Boolean).join("\n\n");
    chunkRows.push({
      chunk_uid: `chunk:zendesk:${ticket.id}:0`,
      item_uid: itemUid,
      parent_type: "item",
      parent_uid: itemUid,
      source: "zendesk",
      project_or_platform: itemRow.project_or_platform,
      customer_name: itemRow.customer_name,
      visibility: "public",
      section: "ticket_summary",
      created_at: ticket.created_at,
      text: summaryText,
      vector: await embedText(summaryText),
    });

    for (const comment of comments) {
      const messageUid = `zendesk:${ticket.id}:comment:${comment.id}`;
      messageRows.push({
        message_uid: messageUid,
        item_uid: itemUid,
        source: "zendesk",
        message_type: comment.public ? "public_reply" : "internal_note",
        visibility: comment.public ? "public" : "internal",
        author: String(comment.author_id),
        created_at: comment.created_at,
        text: comment.body,
        raw_json: JSON.stringify(comment),
      });

      if (comment.body.trim().length > 0) {
        chunkRows.push({
          chunk_uid: `chunk:zendesk:${ticket.id}:comment:${comment.id}:0`,
          item_uid: itemUid,
          parent_type: "message",
          parent_uid: messageUid,
          source: "zendesk",
          project_or_platform: itemRow.project_or_platform,
          customer_name: itemRow.customer_name,
          visibility: comment.public ? "public" : "internal",
          section: comment.public ? "public_reply" : "internal_note",
          created_at: comment.created_at,
          text: comment.body,
          vector: await embedText(comment.body),
        });
      }
    }

    if (ticket.updated_at > maxUpdatedAt) maxUpdatedAt = ticket.updated_at;
  }

  await upsert(itemsTable, "uid", itemRows as unknown as Record<string, unknown>[]);
  await upsert(messagesTable, "message_uid", messageRows as unknown as Record<string, unknown>[]);
  await upsert(chunksTable, "chunk_uid", chunkRows as unknown as Record<string, unknown>[]);

  await saveState(dbPath, { lastSyncedUpdatedAt: maxUpdatedAt });

  return {
    since,
    ticketsFound: tickets.length,
    itemsSynced: itemRows.length,
    messagesSynced: messageRows.length,
    chunksSynced: chunkRows.length,
    watermark: maxUpdatedAt,
  };
}
