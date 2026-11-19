// End-to-end tests for the remote (HTTP) server: starts the mock WebCenter and server/http.js,
// then talks to it with a real MCP Streamable HTTP client. Run with: npm test (after npm run build)

import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const MOCK_PORT = 8811;
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  [http] ${name}${!cond && detail ? `\n      ${detail}` : ""}`);
  if (!cond) failures++;
};

const mock = spawn(process.execPath, ["mock/server.mjs", String(MOCK_PORT)], { stdio: ["ignore", "ignore", "pipe"] });
await new Promise((r) => mock.stderr.once("data", r));
const openSessions = async () => (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/WebCenter/__sessions`)).json()).open;

const servers = [];
async function startServer(port, env) {
  const p = spawn(process.execPath, ["server/http.js"], {
    env: { PATH: process.env.PATH, WEBCENTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/WebCenter/`, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(p);
  let errText = "";
  p.stderr.on("data", (d) => (errText += d));
  p.logs = "";
  p.stdout.on("data", (d) => (p.logs += d));
  await new Promise((resolve, reject) => {
    p.stdout.on("data", (d) => String(d).includes("on http://") && resolve());
    p.on("exit", (code) => reject(new Error(`server exited ${code}: ${errText}`)));
    setTimeout(() => reject(new Error("server did not start: " + errText)), 8000);
  });
  const url = `http://127.0.0.1:${port}`;
  procs[url] = p;
  return url;
}
const procs = {};

async function mcpClient(baseUrl, headers) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let json; try { json = JSON.parse(text); } catch {}
  return { isError: !!r.isError, text, json };
};
const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
const post = (url, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: initBody });

try {
  // ---- OAuth pass-through mode (default)
  const S = await startServer(8812, { MCP_PUBLIC_URL: "https://mcp.example.com", WEBCENTER_OAUTH_ISSUER: "https://abp.esko-saas.com/WebCenter" });

  let r = await fetch(`${S}/healthz`);
  let j = await r.json();
  check("health check", r.status === 200 && j.ok && j.auth_mode === "oauth" && j.version, JSON.stringify(j));

  r = await post(`${S}/mcp`);
  check("no token -> 401 with WWW-Authenticate + resource metadata", r.status === 401 && /Bearer/.test(r.headers.get("www-authenticate") || "") && /resource_metadata=/.test(r.headers.get("www-authenticate") || ""), `${r.status} ${r.headers.get("www-authenticate")}`);

  r = await post(`${S}/mcp`, { Authorization: "Bearer not-a-real-token" });
  check("rejected token -> 401 invalid_token", r.status === 401 && /invalid_token/.test(r.headers.get("www-authenticate") || ""), `${r.status} ${await r.text()}`);

  r = await fetch(`${S}/.well-known/oauth-protected-resource`);
  j = await r.json();
  check("protected resource metadata names WebCenter as the authorization server", j.resource === "https://mcp.example.com/mcp" && j.authorization_servers?.[0] === "https://abp.esko-saas.com/WebCenter", JSON.stringify(j));

  r = await fetch(`${S}/mcp`, { method: "GET", headers: { Authorization: "Bearer mock-token" } });
  check("GET /mcp -> 405 (stateless server)", r.status === 405, String(r.status));
  r = await fetch(`${S}/nope`);
  check("unknown path -> 404", r.status === 404, String(r.status));

  const dom = await mcpClient(S, { Authorization: "Bearer mock-token" });
  const { tools } = await dom.listTools();
  check("remote mode lists 14 tools (no local downloads)", tools.length === 14 && !tools.some((t) => t.name === "webcenter_download_document"), tools.map((t) => t.name).join(", "));
  check("all remote tools read-only", tools.every((t) => t.annotations?.readOnlyHint === true));

  let t = await call(dom, "webcenter_search", { new_search: "proj", columns: ["proj.name", "proj.status"], filters: { "filter(proj.name).query": "ACME*" } });
  check("search works over HTTP", !t.isError && t.json?.rows?.length === 2, t.text);
  t = await call(dom, "webcenter_get_project", { project_name: "ACME-1001 Cereal Carton" });
  check("project details over HTTP", t.json?.project?.attributes?.[0]?.name === "Customer", t.text);
  t = await call(dom, "webcenter_get_attributes", { project_id: "00002_0000001001", document_name: "1001-carton.ARD" });
  check("design specs over HTTP", t.json?.categories?.[0]?.attributes?.some((a) => a.name === "Style"), t.text);
  for (let i = 0; i < 5; i++) await call(dom, "webcenter_find_projects", { page_size: 1 });
  check("one user's many requests share one WebCenter session", (await openSessions()) === 1, `open: ${await openSessions()}`);

  const jane = await mcpClient(S, { Authorization: "Bearer mock-token-jane" });
  t = await call(jane, "webcenter_get_todo_list", {});
  check("second user works with their own token", !t.isError, t.text);
  check("each user gets their own session", (await openSessions()) === 2, `open: ${await openSessions()}`);

  t = await call(dom, "webcenter_diagnostics_raw_response", {});
  check("diagnostics over HTTP reports shared session", /shared session/.test(t.json?.method || ""), t.text);
  await dom.close();
  await jane.close();

  // ---- Service-account fallback mode
  const K = "k".repeat(32);
  const S2 = await startServer(8813, { MCP_AUTH_MODE: "service", MCP_API_KEY: K, WEBCENTER_USERNAME: "MOCKUSER", WEBCENTER_PASSWORD: "mockpass" });
  r = await post(`${S2}/mcp`, { "x-api-key": "wrong" });
  check("service mode: wrong API key -> 401", r.status === 401, String(r.status));
  const svc = await mcpClient(S2, { "x-api-key": K });
  t = await call(svc, "webcenter_find_projects", {});
  check("service mode: valid API key works", !t.isError && t.json?.projects?.length === 3, t.text);
  await svc.close();
  const svc2 = await mcpClient(S2, { Authorization: `Bearer ${K}` });
  t = await call(svc2, "webcenter_get_todo_list", {});
  check("service mode: API key also accepted as Bearer", !t.isError, t.text);
  await svc2.close();

  // ---- Entra ID (Microsoft work account) mode, with a local stand-in for Microsoft's signing keys
  const TENANT = "11111111-2222-3333-4444-555555555555";
  const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
  const AUD = "api://webcenter-mcp";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const jwksServer = http.createServer((q, s2) => { s2.writeHead(200, { "Content-Type": "application/json" }); s2.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => jwksServer.listen(8815, "127.0.0.1", r));
  const mint = (claims = {}, opts = {}) => new SignJWT({ tid: TENANT, preferred_username: "jdoe@anchorbaypackaging.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(opts.iss ?? ISSUER).setAudience(opts.aud ?? AUD)
    .setIssuedAt().setExpirationTime(opts.exp ?? "1h").sign(opts.key ?? privateKey);
  const entraEnv = { MCP_AUTH_MODE: "entra", ENTRA_TENANT_ID: TENANT, ENTRA_AUDIENCE: AUD, ENTRA_ISSUER: ISSUER, ENTRA_JWKS_URL: "http://127.0.0.1:8815/keys", WEBCENTER_USERNAME: "MOCKUSER", WEBCENTER_PASSWORD: "mockpass", MCP_PUBLIC_URL: "https://mcp.example.com" };
  const E = await startServer(8816, entraEnv);

  r = await post(`${E}/mcp`);
  check("entra: no token -> 401 pointing at sign-in metadata", r.status === 401 && /resource_metadata=/.test(r.headers.get("www-authenticate") || ""), String(r.status));
  r = await fetch(`${E}/.well-known/oauth-protected-resource`);
  j = await r.json();
  check("entra: metadata names Microsoft sign-in for the tenant", j.authorization_servers?.[0] === `https://login.microsoftonline.com/${TENANT}/v2.0` && j.scopes_supported?.[0] === "api://webcenter-mcp/access_as_user", JSON.stringify(j));

  const good = await mint();
  const ent = await mcpClient(E, { Authorization: `Bearer ${good}` });
  t = await call(ent, "webcenter_find_projects", {});
  check("entra: valid Microsoft token works", !t.isError && t.json?.projects?.length === 3, t.text);
  await new Promise((res2) => setTimeout(res2, 200));
  check("entra: tool call audit-logged with the user's name", /user=jdoe@anchorbaypackaging\.com tool=webcenter_find_projects/.test(procs[E].logs), procs[E].logs.slice(-400));
  check("entra: audit log contains no tokens", !procs[E].logs.includes(good.slice(20, 60)));
  await ent.close();

  const other = await generateKeyPair("RS256");
  for (const [label, tok] of [
    ["wrong audience", await mint({}, { aud: "api://something-else" })],
    ["expired", await mint({}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["wrong issuer", await mint({}, { iss: "https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/v2.0" })],
    ["forged signature", await mint({}, { key: other.privateKey })],
    ["other organization (tid)", await mint({ tid: "99999999-9999-9999-9999-999999999999" })],
  ]) {
    r = await post(`${E}/mcp`, { Authorization: `Bearer ${tok}` });
    check(`entra: ${label} token -> 401`, r.status === 401, `${r.status} ${await r.text()}`);
  }

  const ER = await startServer(8817, { ...entraEnv, ENTRA_REQUIRED_ROLE: "WebCenter.Read" });
  r = await post(`${ER}/mcp`, { Authorization: `Bearer ${await mint()}` });
  check("entra: required app role missing -> 403", r.status === 403, String(r.status));
  r = await post(`${ER}/mcp`, { Authorization: `Bearer ${await mint({ roles: ["WebCenter.Read"] })}` });
  check("entra: required app role present -> allowed", r.status === 200, `${r.status} ${await r.text()}`);

  // Copilot declarative agent (Entra SSO): token audience is the extra Application ID URI the Teams Developer
  // Portal assigns, and token-store tokens may be v1 (sts.windows.net issuer).
  const SSO_AUD = "api://auth-0f1e2d3c-aaaa-bbbb-cccc-1234567890ab/2d7e2ed2-1936-48f2-8228-ecc9529a4f4e";
  const ES = await startServer(8818, { ...entraEnv, ENTRA_AUDIENCE: `${AUD},${SSO_AUD}`, ENTRA_ISSUER: `${ISSUER},https://sts.windows.net/${TENANT}/` });
  r = await post(`${ES}/mcp`, { Authorization: `Bearer ${await mint({ scp: "access_as_user" }, { aud: SSO_AUD, iss: `https://sts.windows.net/${TENANT}/` })}` });
  check("entra: Copilot agent SSO token (extra audience, v1 issuer) -> allowed", r.status === 200, `${r.status} ${await r.text()}`);
  r = await post(`${ES}/mcp`, { Authorization: `Bearer ${await mint({}, { aud: AUD })}` });
  check("entra: original audience still accepted alongside it", r.status === 200, String(r.status));
  jwksServer.close();

  // ---- Misconfiguration is refused at startup
  let refused = false;
  try {
    await startServer(8814, { MCP_AUTH_MODE: "service", MCP_API_KEY: "short" });
  } catch {
    refused = true;
  }
  check("service mode with a weak API key refuses to start", refused);
  refused = false;
  try {
    await startServer(8818, { MCP_AUTH_MODE: "entra", ENTRA_TENANT_ID: "11111111-2222-3333-4444-555555555555", WEBCENTER_USERNAME: "MOCKUSER", WEBCENTER_PASSWORD: "mockpass" });
  } catch {
    refused = true;
  }
  check("entra mode without an audience refuses to start", refused);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  for (const p of servers) p.kill();
  mock.kill();
}

console.log(failures ? `\n[http] ${failures} check(s) failed` : "\n[http] All checks passed");
process.exit(failures ? 1 : 0);
