// One-time interactive OAuth flow for Zendesk. Run manually (npm run zendesk:auth)
// whenever you need a fresh token — this is not called by the MCP server itself.
//
// Requires in .env: ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET,
// ZENDESK_REDIRECT_URI (e.g. http://localhost:23032/callback).

import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";

const { ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET, ZENDESK_REDIRECT_URI } = process.env;

for (const [name, value] of Object.entries({
  ZENDESK_SUBDOMAIN,
  ZENDESK_CLIENT_ID,
  ZENDESK_CLIENT_SECRET,
  ZENDESK_REDIRECT_URI,
})) {
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
}

const redirectUrl = new URL(ZENDESK_REDIRECT_URI);
const state = randomBytes(16).toString("hex");

const authorizeUrl = new URL(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/oauth/authorizations/new`);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", ZENDESK_CLIENT_ID);
authorizeUrl.searchParams.set("redirect_uri", ZENDESK_REDIRECT_URI);
authorizeUrl.searchParams.set("scope", "read");
authorizeUrl.searchParams.set("state", state);

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, ZENDESK_REDIRECT_URI);
    if (url.pathname !== redirectUrl.pathname) {
      res.writeHead(404).end();
      return;
    }

    const returnedState = url.searchParams.get("state");
    const returnedCode = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    res.writeHead(200, { "Content-Type": "text/html" }).end(
      error
        ? `<p>Auth failed: ${error}. You can close this tab.</p>`
        : `<p>Zendesk auth complete. You can close this tab.</p>`
    );

    server.close();

    if (error) return reject(new Error(`Zendesk returned an error: ${error}`));
    if (returnedState !== state) return reject(new Error("state mismatch — possible CSRF, aborting"));
    if (!returnedCode) return reject(new Error("no code in callback"));
    resolve(returnedCode);
  });

  server.listen(redirectUrl.port, () => {
    console.log(`Listening on ${ZENDESK_REDIRECT_URI} for the OAuth callback...`);
    console.log(`Opening browser to authorize:\n${authorizeUrl}\n`);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${opener} "${authorizeUrl}"`);
  });
});

const tokenResponse = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    grant_type: "authorization_code",
    code,
    client_id: ZENDESK_CLIENT_ID,
    client_secret: ZENDESK_CLIENT_SECRET,
    redirect_uri: ZENDESK_REDIRECT_URI,
    scope: "read",
  }),
});

if (!tokenResponse.ok) {
  console.error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  process.exit(1);
}

const token = { ...(await tokenResponse.json()), obtained_at: Date.now() };

const { writeFile } = await import("node:fs/promises");
await writeFile(".zendesk-token.json", JSON.stringify(token, null, 2));

console.log("Saved token to .zendesk-token.json");
console.log("Fields returned:", Object.keys(token).join(", "));
