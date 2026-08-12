/**
 * Thin wrapper around the Zendesk REST API.
 * Docs: https://developer.zendesk.com/api-reference/ticketing/introduction/
 *
 * Auth: OAuth Bearer token, obtained via `scripts/zendesk-auth.mjs` and
 * kept fresh by ZendeskTokenStore (proactive refresh ahead of expiry).
 */

import { ZendeskTokenStore } from "./zendeskTokenStore.js";

export interface ZendeskConfig {
  subdomain: string;
  tokenStore: ZendeskTokenStore;
}

export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: string;
  priority: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  requester_id: number;
  organization_id: number | null;
  custom_fields?: Array<{ id: number; value: unknown }>;
}

export interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  organization_id: number | null;
  tags: string[];
}

export interface ZendeskOrganization {
  id: number;
  name: string;
  tags: string[];
  organization_fields?: Record<string, unknown>;
}

/**
 * Zendesk search syntax treats `"`, `:`, and whitespace as structural
 * (quoting, operators, term separation). Strip/escape them before
 * interpolating caller-supplied values into a query string, so a value
 * like `Foo" requester:other@example.com` can't inject extra search
 * operators or escape out of an intended field.
 */
function sanitizeBareTerm(value: string): string {
  return value.replace(/[":]/g, "").replace(/\s+/g, " ").trim();
}

function quoteQueryValue(value: string): string {
  // Zendesk search doesn't support escaping quotes within a quoted phrase,
  // so the only safe option is to strip them (and backslashes/newlines)
  // rather than try to escape them.
  const cleaned = value.replace(/["\\]/g, "").replace(/[\r\n]+/g, " ").trim();
  return `"${cleaned}"`;
}

export class ZendeskClient {
  private baseUrl: string;
  private tokenStore: ZendeskTokenStore;

  constructor(config: ZendeskConfig) {
    this.baseUrl = `https://${config.subdomain}.zendesk.com/api/v2`;
    this.tokenStore = config.tokenStore;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const accessToken = await this.tokenStore.getAccessToken();
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), { headers: await this.authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Zendesk API error ${res.status} on ${path}: ${body}`);
    }
    return (await res.json()) as T;
  }

  /** Like `request`, but for full pagination URLs Zendesk already returns (e.g. `next_page`). */
  private async requestUrl<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: await this.authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Zendesk API error ${res.status} on ${url}: ${body}`);
    }
    return (await res.json()) as T;
  }

  /** Full-text search across tickets. Zendesk search syntax: https://developer.zendesk.com/documentation/ticketing/using-the-zendesk-api/zendesk-api-search/ */
  async searchTickets(query: string, opts?: { sortBy?: string; sortOrder?: "asc" | "desc" }) {
    const q = `type:ticket ${sanitizeBareTerm(query)}`;
    return this.request<{ results: ZendeskTicket[]; count: number }>("/search.json", {
      query: q,
      ...(opts?.sortBy ? { sort_by: opts.sortBy } : {}),
      ...(opts?.sortOrder ? { sort_order: opts.sortOrder } : {}),
    });
  }

  async getTicket(id: number) {
    return this.request<{ ticket: ZendeskTicket }>(`/tickets/${id}.json`);
  }

  async getTicketComments(id: number) {
    return this.request<{ comments: Array<{ id: number; author_id: number; body: string; created_at: string; public: boolean }> }>(
      `/tickets/${id}/comments.json`
    );
  }

  async getUser(id: number) {
    return this.request<{ user: ZendeskUser }>(`/users/${id}.json`);
  }

  /** Resolve an agent's email to their Zendesk user id, e.g. to attribute comment authorship. */
  async getUserByEmail(email: string) {
    const { users } = await this.request<{ users: ZendeskUser[] }>("/users/search.json", { query: email });
    return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async getOrganization(id: number) {
    return this.request<{ organization: ZendeskOrganization }>(`/organizations/${id}.json`);
  }

  /** Tickets requested by a given user, for "customer history" lookups. */
  async searchTicketsByRequester(email: string) {
    return this.request<{ results: ZendeskTicket[]; count: number }>("/search.json", {
      query: `type:ticket requester:${sanitizeBareTerm(email)}`,
    });
  }

  /** Tickets tied to a given customer organization by name, for org-level "customer history" lookups. */
  async searchTicketsByOrganization(organizationName: string) {
    return this.request<{ results: ZendeskTicket[]; count: number }>("/search.json", {
      query: `type:ticket organization:${quoteQueryValue(organizationName)}`,
    });
  }

  /**
   * Tickets updated/solved within a date range, e.g. for the daily summary tool.
   *
   * Zendesk's search endpoint paginates at 100 results/page and caps total
   * reachable results at 1000 regardless of pagination, so this follows
   * `next_page` until exhausted (or that cap). If `count` exceeds 1000, the
   * tail of the window is unreachable via search and this logs a warning —
   * callers with wider windows should switch to the incremental export API.
   */
  async ticketsUpdatedSince(isoDate: string, opts?: { statuses?: string[]; assignee?: string; before?: string }) {
    const statusFilter = opts?.statuses?.length
      ? ` status<${opts.statuses.map(sanitizeBareTerm).join(" status<")}`
      : "";
    const assigneeFilter = opts?.assignee ? ` assignee:${sanitizeBareTerm(opts.assignee)}` : "";
    const beforeFilter = opts?.before ? ` updated<${sanitizeBareTerm(opts.before)}` : "";

    let page = await this.request<{ results: ZendeskTicket[]; count: number; next_page: string | null }>(
      "/search.json",
      {
        query: `type:ticket updated>=${isoDate}${beforeFilter}${statusFilter}${assigneeFilter}`,
        sort_by: "updated_at",
        sort_order: "desc",
      }
    );
    const results = [...page.results];
    const count = page.count;

    while (page.next_page && results.length < 1000) {
      page = await this.requestUrl<{ results: ZendeskTicket[]; count: number; next_page: string | null }>(
        page.next_page
      );
      results.push(...page.results);
    }

    if (count > 1000) {
      console.error(
        `ticketsUpdatedSince: ${count} tickets matched but Zendesk search caps reachable results at 1000 ` +
          `(fetched ${results.length}). Narrow the window or switch to the incremental export API to avoid gaps.`
      );
    }

    return { results, count };
  }
}

export function zendeskClientFromEnv(): ZendeskClient {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const clientId = process.env.ZENDESK_CLIENT_ID;
  const clientSecret = process.env.ZENDESK_CLIENT_SECRET;
  if (!subdomain || !clientId || !clientSecret) {
    throw new Error(
      "Missing Zendesk env vars. Set ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET (see .env.example)."
    );
  }
  const tokenStore = new ZendeskTokenStore({
    subdomain,
    clientId,
    clientSecret,
    tokenPath: ".zendesk-token.json",
  });
  return new ZendeskClient({ subdomain, tokenStore });
}
