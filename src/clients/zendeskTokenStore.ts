/**
 * Reads/refreshes the OAuth token saved by `scripts/zendesk-auth.mjs`.
 * Proactively refreshes ahead of expiry so callers always get a live access token.
 */

import { readFile, writeFile } from "node:fs/promises";

const REFRESH_MARGIN_MS = 60_000;

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  obtained_at: number; // ms epoch
  [key: string]: unknown; // preserve any other fields Zendesk returns (token_type, scope, ...)
}

export interface ZendeskTokenStoreConfig {
  subdomain: string;
  clientId: string;
  clientSecret: string;
  tokenPath: string;
}

export class ZendeskTokenStore {
  private subdomain: string;
  private clientId: string;
  private clientSecret: string;
  private tokenPath: string;

  constructor(config: ZendeskTokenStoreConfig) {
    this.subdomain = config.subdomain;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.tokenPath = config.tokenPath;
  }

  async getAccessToken(): Promise<string> {
    const token = await this.load();
    if (this.isExpired(token)) {
      return this.refresh(token);
    }
    return token.access_token;
  }

  private async load(): Promise<StoredToken> {
    let raw: string;
    try {
      raw = await readFile(this.tokenPath, "utf8");
    } catch {
      throw new Error(
        `No Zendesk OAuth token found at ${this.tokenPath}. Run \`npm run zendesk:auth\` first.`
      );
    }
    return JSON.parse(raw) as StoredToken;
  }

  private isExpired(token: StoredToken): boolean {
    return Date.now() >= token.obtained_at + token.expires_in * 1000 - REFRESH_MARGIN_MS;
  }

  private async refresh(token: StoredToken): Promise<string> {
    const res = await fetch(`https://${this.subdomain}.zendesk.com/oauth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Zendesk token refresh failed (${res.status}): ${body}. Try \`npm run zendesk:auth\` again.`
      );
    }

    const refreshed = (await res.json()) as StoredToken;
    // Zendesk may or may not rotate the refresh_token; fall back to the old one if omitted.
    const updated: StoredToken = {
      ...token,
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? token.refresh_token,
      obtained_at: Date.now(),
    };

    await writeFile(this.tokenPath, JSON.stringify(updated, null, 2));
    return updated.access_token;
  }
}
