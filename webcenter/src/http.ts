#!/usr/bin/env node
// Remote (hosted) WebCenter MCP server: MCP over Streamable HTTP, for Copilot Studio / Microsoft 365 Copilot.
//
// Auth modes (MCP_AUTH_MODE):
//   entra   Callers sign in with their Microsoft work account (Entra ID); Copilot sends the Entra access token as
//           "Authorization: Bearer <token>" and the server verifies it (signature, issuer, audience, expiry, optional
//           app role). WebCenter calls run as one service account (WEBCENTER_USERNAME / WEBCENTER_PASSWORD), and every
//           tool call is logged with the signed-in user's name. Works with any WebCenter version.
//   oauth   Each caller sends their own WebCenter OAuth access token, passed straight to WebCenter (needs WebCenter
//           26.07+ with the OAuth SSO plugin). The server stores no credentials; each user sees only what their own
//           WebCenter account can see.
//   service Fallback/testing: callers present a shared API key; WebCenter calls run as one service account.
//
// The desktop (stdio) build in index.ts is unaffected.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { WebCenterClient, WebCenterError, loadConfig, type WebCenterConfig } from "./client.js";
import { Lookup } from "./lookup.js";
import { createServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

// ---- configuration -------------------------------------------------------------
let mockNote = "";
if ((process.env.WEBCENTER_BASE_URL || "").trim().toLowerCase() === "mock") {
  // @ts-ignore - plain JS module
  const { startMock } = await import("../mock/server.mjs");
  const { baseUrl } = await startMock(0);
  process.env.WEBCENTER_BASE_URL = baseUrl;
  mockNote = " This server is connected to a MOCK WebCenter with made-up sample data; say so when presenting results.";
}

const base: WebCenterConfig = { ...loadConfig(), allowLive: true };
const PORT = Number(process.env.PORT || process.env.MCP_PORT || 8787);
const HOST = process.env.MCP_HOST || "127.0.0.1"; // behind the HTTPS reverse proxy by default
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL || "").replace(/\/+$/, "");
const AUTH_MODE = (process.env.MCP_AUTH_MODE || "oauth").trim().toLowerCase() as "oauth" | "service" | "entra";
const API_KEY = process.env.MCP_API_KEY || "";
const OAUTH_ISSUER = (process.env.WEBCENTER_OAUTH_ISSUER || "").trim();
const MAX_BODY = 1024 * 1024;
const CLIENT_IDLE_MS = 10 * 60 * 1000;

if (!["oauth", "service", "entra"].includes(AUTH_MODE)) throw new Error(`MCP_AUTH_MODE must be "entra", "oauth" or "service", not "${AUTH_MODE}".`);

// Entra ID (Microsoft work account) settings
const ENTRA_TENANT = (process.env.ENTRA_TENANT_ID || "").trim();
const ENTRA_AUDIENCES = (process.env.ENTRA_AUDIENCE || "").split(",").map((s) => s.trim()).filter(Boolean);
const ENTRA_REQUIRED_ROLE = (process.env.ENTRA_REQUIRED_ROLE || "").trim();
const ENTRA_ISSUERS = (process.env.ENTRA_ISSUER || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!ENTRA_ISSUERS.length && ENTRA_TENANT) ENTRA_ISSUERS.push(`https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`, `https://sts.windows.net/${ENTRA_TENANT}/`);
const ENTRA_JWKS_URL = (process.env.ENTRA_JWKS_URL || (ENTRA_TENANT ? `https://login.microsoftonline.com/${ENTRA_TENANT}/discovery/v2.0/keys` : "")).trim();
const entraJwks = AUTH_MODE === "entra" && ENTRA_JWKS_URL ? createRemoteJWKSet(new URL(ENTRA_JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 6 * 60 * 60 * 1000 }) : undefined;
if (AUTH_MODE === "entra") {
  if (!/^[0-9a-f-]{36}$/i.test(ENTRA_TENANT) && !process.env.ENTRA_ISSUER) throw new Error("MCP_AUTH_MODE=entra needs ENTRA_TENANT_ID (your Directory (tenant) ID).");
  if (!ENTRA_AUDIENCES.length) throw new Error("MCP_AUTH_MODE=entra needs ENTRA_AUDIENCE (the server app's Application ID URI and/or client ID).");
  if (!base.username || !base.password) throw new Error("MCP_AUTH_MODE=entra needs WEBCENTER_USERNAME and WEBCENTER_PASSWORD for the WebCenter service account.");
}
if (AUTH_MODE === "service") {
  if (API_KEY.length < 24) throw new Error("MCP_AUTH_MODE=service needs MCP_API_KEY of at least 24 characters.");
  if (!base.username || !base.password) throw new Error("MCP_AUTH_MODE=service needs WEBCENTER_USERNAME and WEBCENTER_PASSWORD.");
}

// ---- per-caller WebCenter clients ------------------------------------------------
// One client per token (oauth) or one shared client (service). Each keeps one WebCenter session open while in use.
interface Entry {
  client: WebCenterClient;
  lookup: Lookup;
  lastUsed: number;
  verified?: Promise<void>;
}
const clients = new Map<string, Entry>();

function entryFor(key: string, cfg: WebCenterConfig): Entry {
  let e = clients.get(key);
  if (!e) {
    const client = new WebCenterClient(cfg);
    e = { client, lookup: new Lookup(client), lastUsed: Date.now() };
    clients.set(key, e);
  }
  e.lastUsed = Date.now();
  return e;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of clients) {
    if (now - e.lastUsed > CLIENT_IDLE_MS) {
      clients.delete(k);
      void e.client.close();
    }
  }
}, 60_000).unref();

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---- HTTP helpers ------------------------------------------------------------------
function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function unauthorized(res: http.ServerResponse, error: "invalid_request" | "invalid_token", description: string) {
  const parts = [`Bearer realm="webcenter-mcp"`, `error="${error}"`, `error_description="${description.replace(/"/g, "'")}"`];
  if (PUBLIC_URL && (OAUTH_ISSUER || (AUTH_MODE === "entra" && ENTRA_TENANT))) parts.push(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
  sendJson(res, 401, { error, error_description: description }, { "WWW-Authenticate": parts.join(", ") });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  const m = typeof h === "string" ? h.match(/^Bearer\s+(.+)$/i) : null;
  return m?.[1]?.trim() || undefined;
}

/** Work out which WebCenter client serves this request, or answer 401. */
async function authenticate(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ entry: Entry; user?: string } | undefined> {
  if (AUTH_MODE === "entra") {
    const token = bearer(req);
    if (!token) {
      unauthorized(res, "invalid_request", "Sign in with your Microsoft work account.");
      return undefined;
    }
    let claims: JWTPayload & Record<string, any>;
    try {
      ({ payload: claims } = await jwtVerify(token, entraJwks!, { issuer: ENTRA_ISSUERS, audience: ENTRA_AUDIENCES, clockTolerance: 60 }));
    } catch (err: any) {
      unauthorized(res, "invalid_token", `Microsoft sign-in token rejected (${err?.code || "invalid"}). Sign in again.`);
      return undefined;
    }
    if (ENTRA_TENANT && claims.tid && String(claims.tid).toLowerCase() !== ENTRA_TENANT.toLowerCase()) {
      unauthorized(res, "invalid_token", "This sign-in is from a different organization.");
      return undefined;
    }
    if (ENTRA_REQUIRED_ROLE && !(Array.isArray(claims.roles) && claims.roles.includes(ENTRA_REQUIRED_ROLE))) {
      sendJson(res, 403, { error: "insufficient_scope", error_description: `You need the "${ENTRA_REQUIRED_ROLE}" role for this app. Ask IT for access.` });
      return undefined;
    }
    const user = String(claims.preferred_username || claims.upn || claims.email || claims.oid || claims.sub || "unknown");
    return { entry: entryFor("service", base), user };
  }

  if (AUTH_MODE === "service") {
    const key = (req.headers["x-api-key"] as string | undefined) ?? bearer(req);
    if (!key || !safeEqual(key, API_KEY)) {
      unauthorized(res, key ? "invalid_token" : "invalid_request", "A valid API key is required.");
      return undefined;
    }
    return { entry: entryFor("service", base), user: "api-key" };
  }

  const token = bearer(req);
  if (!token) {
    unauthorized(res, "invalid_request", "Sign in to WebCenter: an OAuth access token is required.");
    return undefined;
  }
  const e = entryFor(hash(token), { ...base, oauthToken: token, username: undefined, password: undefined, ssoiid: undefined });
  // Check the token with WebCenter once, so an expired token gets a proper 401 (Copilot then refreshes it).
  e.verified ??= e.client.verifyLogin().catch((err) => {
    clients.delete(hash(token));
    throw err;
  });
  try {
    await e.verified;
  } catch (err) {
    if (err instanceof WebCenterError && err.code === "001") {
      unauthorized(res, "invalid_token", "WebCenter did not accept this sign-in. Sign in again.");
      return undefined;
    }
    throw err;
  }
  return { entry: e, user: `webcenter-token:${hash(token).slice(0, 8)}` };
}

// ---- server -----------------------------------------------------------------------
const httpServer = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url || "/", "http://localhost");
  res.on("finish", () => {
    if (url.pathname !== "/healthz") console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });

  try {
    if (url.pathname === "/healthz" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, version: SERVER_VERSION, auth_mode: AUTH_MODE, webcenter: base.baseUrl, active_users: clients.size });
    }

    if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
      if (AUTH_MODE === "entra" && PUBLIC_URL && ENTRA_TENANT) {
        return sendJson(res, 200, { resource: `${PUBLIC_URL}/mcp`, authorization_servers: [`https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`], bearer_methods_supported: ["header"], scopes_supported: ENTRA_AUDIENCES.filter((a) => a.startsWith("api://")).map((a) => `${a}/access_as_user`), resource_name: "Esko WebCenter (read-only)" });
      }
      if (AUTH_MODE !== "oauth" || !OAUTH_ISSUER || !PUBLIC_URL) return sendJson(res, 404, { error: "not_configured" });
      return sendJson(res, 200, { resource: `${PUBLIC_URL}/mcp`, authorization_servers: [OAUTH_ISSUER], bearer_methods_supported: ["header"], resource_name: "Esko WebCenter (read-only)" });
    }

    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not_found" });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });

    const auth = await authenticate(req, res);
    if (!auth) return;
    const entry = auth.entry;

    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    // Audit: who ran which tool (no arguments or results are logged)
    for (const msg of Array.isArray(body) ? body : [body]) {
      if (msg?.method === "tools/call") console.log(`${new Date().toISOString()} user=${auth.user} tool=${String(msg?.params?.name ?? "?")}`);
    }

    // Stateless: a fresh MCP server + transport per request, bound to this caller's WebCenter client.
    const server = createServer(entry.client, entry.lookup, { remote: true, note: mockNote });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err: any) {
    console.error(`${new Date().toISOString()} error: ${err?.message || err}`);
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

httpServer.requestTimeout = 180_000;
httpServer.listen(PORT, HOST, () => {
  console.log(`WebCenter MCP ${SERVER_VERSION} (remote, read-only) on http://${HOST}:${PORT}/mcp - auth: ${AUTH_MODE}, WebCenter: ${base.baseUrl}`);
});

async function shutdown() {
  httpServer.close();
  await Promise.race([Promise.all([...clients.values()].map((e) => e.client.close())), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
