// End-to-end test: starts the mock WebCenter, launches the bundled MCP server over stdio,
// and calls every tool through a real MCP client. Run with: npm test (after npm run build)

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DL = mkdtempSync(join(tmpdir(), "wc-dl-"));
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 8799;
const mock = spawn(process.execPath, ["mock/server.mjs", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
await new Promise((r) => mock.stderr.once("data", r));

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n      ${detail}` : ""}`);
  if (!cond) failures++;
};

async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["server/index.js"], env: { PATH: process.env.PATH, ...env }, stderr: "ignore" });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const base = { WEBCENTER_BASE_URL: `http://127.0.0.1:${PORT}/WebCenter/`, WEBCENTER_USERNAME: "MOCKUSER", WEBCENTER_PASSWORD: "mockpass", WEBCENTER_DOWNLOAD_DIR: DL };
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let json; try { json = JSON.parse(text); } catch {}
  return { isError: !!r.isError, text, json };
};

try {
  const c = await connect(base);

  const { tools } = await c.listTools();
  check("lists 15 tools", tools.length === 15, tools.map((t) => t.name).join(", "));
  check("every tool is marked read-only", tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false));
  check("every tool has a description", tools.every((t) => (t.description || "").length > 40));

  let r = await call(c, "webcenter_find_projects", {});
  check("find_projects (member) returns projects", !r.isError && r.json.projects.length === 3, r.text);
  check("dates converted to ISO", r.json?.projects?.[0]?.modified?.endsWith("Z"), r.text.slice(0, 300));
  check("IDs stay strings", typeof r.json?.projects?.[0]?.id === "string" && r.json.projects[0].id.startsWith("00002_"));

  r = await call(c, "webcenter_find_projects", { scope: "all_by_name", name_contains: "acme" });
  check("find_projects all_by_name wildcards the name", r.json?.projects?.length === 2, r.text);
  r = await call(c, "webcenter_find_projects", { scope: "all_by_name" });
  check("all_by_name without name is a clear error", r.isError && /name_contains/.test(r.text));
  r = await call(c, "webcenter_find_projects", { scope: "templates" });
  check("find_projects templates", r.json?.projects?.length === 1 && r.json.projects[0].is_template === true, r.text);
  r = await call(c, "webcenter_find_projects", { status: "Completed" });
  check("status filter", r.json?.projects?.length === 1, r.text);

  r = await call(c, "webcenter_get_project", { project_id: "00002_0000001001" });
  check("get_project returns folders and attributes", r.json?.project?.folders?.length === 2 && r.json.project.attributes.length === 2, r.text);
  r = await call(c, "webcenter_get_project", { project_name: "ACME-1002 Shipper RSC" });
  check("get_project by name", r.json?.project?.id === "00002_0000001002", r.text);
  r = await call(c, "webcenter_get_project", { project_id: "00002_9999999999" });
  check("get_project unknown id is an error", r.isError, r.text);

  r = await call(c, "webcenter_list_documents", { project_id: "00002_0000001001" });
  check("list_documents returns 2 docs", r.json?.documents?.length === 2, r.text);
  check("viewer_url is absolute", r.json?.documents?.[0]?.viewer_url?.startsWith(`http://127.0.0.1:${PORT}/WebCenter/openannotator_mp.jsp?DocVer=`), r.json?.documents?.[0]?.viewer_url);
  r = await call(c, "webcenter_list_documents", { project_id: "00002_0000001001", folder_names: ["Structural"], include_attributes: true });
  check("folder filter + attributes", r.json?.documents?.length === 1 && r.json.documents[0].attributes?.length === 2, r.text);
  r = await call(c, "webcenter_list_documents", { project_name: "nope" });
  check("unknown project -> error 011 with hint", r.isError && /011/.test(r.text) && /visible/.test(r.text), r.text);

  r = await call(c, "webcenter_get_document_history", { document_id: "00002_0000003001" });
  check("history returns 3 versions", r.json?.versions?.length === 3, r.text);
  check("history shows pending approver", r.json?.waiting_on_approvers?.[0]?.username === undefined && r.json?.waiting_on_approvers?.[0]?.name === "Bob Brand", JSON.stringify(r.json?.waiting_on_approvers));
  check("history shows rejection comment", r.json?.versions?.[0]?.stages?.[0]?.approvers?.[0]?.comment === "Logo too small", JSON.stringify(r.json?.versions?.[0]));
  r = await call(c, "webcenter_get_document_history", { project_name: "ACME-1002 Shipper RSC", document_name: "shipper-rsc.ARD" });
  check("history by project + name", r.json?.name === "shipper-rsc.ARD", r.text);
  r = await call(c, "webcenter_get_document_history", {});
  check("history without identifiers is a clear error", r.isError, r.text);

  r = await call(c, "webcenter_get_todo_list", {});
  check("todo list has a task and an approval", r.json?.tasks_to_do?.length === 1 && r.json?.approvals_to_do?.length === 1, r.text);
  check("todo user parsed", r.json?.user?.username === "MOCKUSER", JSON.stringify(r.json?.user));
  r = await call(c, "webcenter_get_todo_list", { for_username: "nobody" });
  check("todo for unknown user -> error 031", r.isError && /031/.test(r.text), r.text);

  r = await call(c, "webcenter_find_users", {});
  check("find_users all", r.json?.users?.length === 3, r.text);
  r = await call(c, "webcenter_find_users", { types: ["administrators"] });
  check("find_users admins", r.json?.users?.length === 1, r.text);
  r = await call(c, "webcenter_find_users", { name_contains: "jane", include_details: true });
  check("find_users name filter + details", r.json?.users?.length === 1 && r.json.users[0].email === "jane.smith@example.com", r.text);

  r = await call(c, "webcenter_get_user", { username: "MOCKUSER" });
  check("get_user role + groups", r.json?.role === "administrator" && r.json?.groups?.length === 2, r.text);
  r = await call(c, "webcenter_get_user", { username: "ghost" });
  check("get_user unknown -> error", r.isError && /031/.test(r.text), r.text);

  // ---- fixes for live-data gaps
  r = await call(c, "webcenter_find_projects", { scope: "all_by_name", name_contains: "1002" });
  check("group manager shown as the group, not a user with the same ID", r.json?.projects?.[0]?.manager?.name === "US ENGINEERS" && r.json.projects[0].manager.kind === "group", JSON.stringify(r.json?.projects?.[0]?.manager));
  check("project creator shown", r.json?.projects?.[0]?.created_by?.username === "MOCKUSER", JSON.stringify(r.json?.projects?.[0]?.created_by));
  check("status name filled from search", r.json?.projects?.[0]?.status === "Active", JSON.stringify(r.json?.projects?.[0]));
  r = await call(c, "webcenter_get_project", { project_id: "00002_0000001001" });
  check("get_project attributes use names", r.json?.project?.attributes?.[0]?.name === "Customer" && r.json.project.attributes[0].value === "ACME Foods", JSON.stringify(r.json?.project?.attributes));
  r = await call(c, "webcenter_list_documents", { project_id: "00002_0000001001" });
  check("document list shows version numbers", r.json?.documents?.every((d) => /^\d+$/.test(d.version || "")), JSON.stringify(r.json?.documents?.map((d) => d.version)));

  // ---- engineering tools
  r = await call(c, "webcenter_get_attributes", { project_id: "00002_0000001001" });
  check("project attributes", r.json?.level === "project" && r.json.categories?.[0]?.attributes?.[0]?.name === "Customer", r.text);
  r = await call(c, "webcenter_get_attributes", { project_id: "00002_0000001001", document_name: "1001-carton.ARD" });
  check("empty attributes hidden by default", r.json?.categories?.[0]?.hidden_empty_attributes === 1 && !r.json.categories[0].attributes.some((a) => a.name === "Drawn By 2"), r.text);
  check("DateTime attribute shown as a date", r.json?.categories?.[0]?.attributes?.find((a) => a.name === "Date 1")?.value === "2026-10-09", r.text);
  check("i18n labels dropped", !r.json?.categories?.[0]?.attributes?.find((a) => a.name === "Style2")?.label, r.text);
  check("document attributes with unit + doc reference", r.json?.categories?.[0]?.attributes?.some((a) => a.unit === "in") && r.json.categories[0].attributes.some((a) => a.referenced_documents?.[0]?.name === "shipper-rsc.ARD"), r.text);
  r = await call(c, "webcenter_get_attributes", { project_id: "00002_0000001001", document_name: "1001-carton.ARD", include_empty: true });
  check("include_empty shows empty attributes", r.json?.categories?.[0]?.attributes?.some((a) => a.name === "Drawn By 2"), r.text);
  r = await call(c, "webcenter_get_attributes", { project_id: "00002_0000001003" });
  check("no attributes (043) is not an error", !r.isError && r.json?.note, r.text);

  let raw = await c.callTool({ name: "webcenter_get_thumbnail", arguments: { document_id: "00002_0000003001" } });
  check("document thumbnail returns a PNG image", raw.content?.[0]?.type === "image" && raw.content[0].mimeType === "image/png" && raw.content[0].data.length > 20, JSON.stringify(raw).slice(0, 200));
  raw = await c.callTool({ name: "webcenter_get_thumbnail", arguments: { project_name: "ACME-1001 Cereal Carton" } });
  check("project thumbnail", raw.content?.[0]?.type === "image", JSON.stringify(raw).slice(0, 200));
  r = await call(c, "webcenter_get_thumbnail", { document_id: "00002_0000009999" });
  check("thumbnail of unknown doc -> error 021", r.isError && /021/.test(r.text), r.text);

  r = await call(c, "webcenter_download_document", { document_id: "00002_0000003101" });
  check("download saves file", !r.isError && existsSync(r.json?.saved_to) && readFileSync(r.json.saved_to, "utf8").includes("shipper-rsc.ARD"), r.text);
  const first = r.json?.saved_to;
  r = await call(c, "webcenter_download_document", { project_name: "ACME-1002 Shipper RSC", document_name: "shipper-rsc.ARD" });
  check("second download never overwrites", !r.isError && r.json?.saved_to !== first && /\(1\)/.test(r.json.saved_to), r.text);

  r = await call(c, "webcenter_get_group", { group_name: "US ENGINEERS" });
  check("group members", r.json?.member_count === 2, r.text);
  r = await call(c, "webcenter_browse_characteristics", {});
  check("characteristics tree (names trimmed)", r.json?.tree?.[0]?.children?.[1]?.name === "BRANDCO", r.text);
  r = await call(c, "webcenter_find_projects_by_characteristic", { characteristic_path: "\\\\Customer\\\\ACME Foods" });
  check("projects by characteristic", r.json?.total === 2, r.text);

  r = await call(c, "webcenter_diagnostics_raw_response", { page: "GetDocumentList.jsp", params: { projectid: "00002_0000001001" } });
  check("raw diagnostics returns XML", !r.isError && r.text.includes("<document_list"), r.text.slice(0, 200));
  r = await call(c, "webcenter_diagnostics_raw_response", { page: "DeleteProject.jsp", params: { projectid: "00002_0000001001" } });
  check("raw diagnostics refuses write pages", r.isError && /Not allowed/.test(r.text), r.text.slice(0, 200));

  r = await call(c, "webcenter_search", { new_search: "des" });
  check("search rows flattened with labels", !r.isError && r.json?.rows?.length === 3 && r.json.rows[0]["Document Name"], r.text);
  r = await call(c, "webcenter_search", { new_search: "proj", columns: ["proj.name", "proj.status"], filters: { "filter(proj.name).query": "ACME*" } });
  check("search: project status column", r.json?.rows?.every((x) => x.Status === "Active"), r.text);
  r = await call(c, "webcenter_search", {});
  check("search without type is a clear error", r.isError, r.text);
  await c.close();

  // Login failure
  const bad = await connect({ ...base, WEBCENTER_PASSWORD: "wrong" });
  r = await call(bad, "webcenter_find_projects", {});
  check("wrong password -> error 001 with hint", r.isError && /001/.test(r.text) && /password/.test(r.text), r.text);
  await bad.close();

  // SAML default login returns HTML; ssoiid fixes it
  const sso = await connect({ ...base, WEBCENTER_USERNAME: "SSOUSER" });
  r = await call(sso, "webcenter_find_projects", {});
  check("SAML HTML page -> explains WEBCENTER_SSOIID", r.isError && /WEBCENTER_SSOIID/.test(r.text), r.text);
  await sso.close();
  const sso2 = await connect({ ...base, WEBCENTER_USERNAME: "SSOUSER", WEBCENTER_SSOIID: "00001_0000000001" });
  r = await call(sso2, "webcenter_find_projects", {});
  check("ssoiid gets past SAML", !r.isError, r.text);
  await sso2.close();

  // OAuth bearer token instead of username/password
  const oauth = await connect({ WEBCENTER_BASE_URL: base.WEBCENTER_BASE_URL, WEBCENTER_OAUTH_TOKEN: "mock-token" });
  r = await call(oauth, "webcenter_get_todo_list", {});
  check("OAuth token works", !r.isError, r.text);
  await oauth.close();

  // Built-in mock mode (WEBCENTER_BASE_URL=mock): no separate mock process, no credentials
  const builtin = await connect({ WEBCENTER_BASE_URL: "mock" });
  r = await call(builtin, "webcenter_list_documents", { project_name: "ACME-1001 Cereal Carton" });
  check("built-in mock mode works", !r.isError && r.json?.documents?.length === 2, r.text);
  await builtin.close();

  // Live guard: a non-local site is refused unless WEBCENTER_ALLOW_LIVE=true (no request is made)
  const live = await connect({ ...base, WEBCENTER_BASE_URL: "https://example-site.esko-saas.com/WebCenter/" });
  r = await call(live, "webcenter_find_projects", {});
  check("live site refused without WEBCENTER_ALLOW_LIVE", r.isError && /WEBCENTER_ALLOW_LIVE/.test(r.text), r.text);
  await live.close();

  // Unreachable server gives a readable error
  const down = await connect({ ...base, WEBCENTER_BASE_URL: "http://127.0.0.1:1/WebCenter/" });
  r = await call(down, "webcenter_find_projects", {});
  check("unreachable server -> readable error", r.isError && /Could not reach/.test(r.text), r.text);
  await down.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  mock.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
