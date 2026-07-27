/**
 * Thin wrapper around the Zendesk REST API.
 * Docs: https://developer.zendesk.com/api-reference/ticketing/introduction/
 *
 * Auth: Zendesk accepts basic auth of the form `email/token:api_token`,
 * base64-encoded. We build that header once and reuse it.
 */

export interface ZendeskConfig {
  subdomain: string;
  email: string;
  apiToken: string;
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

export class ZendeskClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(config: ZendeskConfig) {
    this.baseUrl = `https://${config.subdomain}.zendesk.com/api/v2`;
    const raw = `${config.email}/token:${config.apiToken}`;
    this.authHeader = `Basic ${Buffer.from(raw).toString("base64")}`;
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Zendesk API error ${res.status} on ${path}: ${body}`);
    }
    return (await res.json()) as T;
  }

  /** Full-text search across tickets. Zendesk search syntax: https://developer.zendesk.com/documentation/ticketing/using-the-zendesk-api/zendesk-api-search/ */
  async searchTickets(query: string, opts?: { sortBy?: string; sortOrder?: "asc" | "desc" }) {
    const q = `type:ticket ${query}`;
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

  async getOrganization(id: number) {
    return this.request<{ organization: ZendeskOrganization }>(`/organizations/${id}.json`);
  }

  /** Tickets requested by a given user, for "customer history" lookups. */
  async searchTicketsByRequester(email: string) {
    return this.request<{ results: ZendeskTicket[]; count: number }>("/search.json", {
      query: `type:ticket requester:${email}`,
    });
  }

  /** Tickets tied to a given customer organization by name, for org-level "customer history" lookups. */
  async searchTicketsByOrganization(organizationName: string) {
    return this.request<{ results: ZendeskTicket[]; count: number }>("/search.json", {
      query: `type:ticket organization:"${organizationName}"`,
    });
  }

  /** Tickets updated/solved within a date range, e.g. for the daily summary tool. */
  async ticketsUpdatedSince(isoDate: string, opts?: { statuses?: string[]; assignee?: string }) {
    const statusFilter = opts?.statuses?.length ? ` status<${opts.statuses.join(" status<")}` : "";
    const assigneeFilter = opts?.assignee ? ` assignee:${opts.assignee}` : "";
    return this.request<{ results: ZendeskTicket[]; count: number }>("/search.json", {
      query: `type:ticket updated>=${isoDate}${statusFilter}${assigneeFilter}`,
      sort_by: "updated_at",
      sort_order: "desc",
    });
  }
}

export function zendeskClientFromEnv(): ZendeskClient {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const apiToken = process.env.ZENDESK_API_TOKEN;
  if (!subdomain || !email || !apiToken) {
    throw new Error(
      "Missing Zendesk env vars. Set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN (see .env.example)."
    );
  }
  return new ZendeskClient({ subdomain, email, apiToken });
}
