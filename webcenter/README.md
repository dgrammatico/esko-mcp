# Esko WebCenter MCP server (read-only)

Gives AI assistants read-only access to Esko WebCenter through the WebCenter SDK (JSP calls over HTTPS). Built from the *WebCenter 26.07 SDK* document and verified against `abp.esko-saas.com` (WebCenter 25.07).

Two editions from one codebase:

| Edition | Entry point | For | Guide |
|---|---|---|---|
| Desktop | `src/index.ts` → `server/index.js` (stdio) | Claude Desktop extension (`.mcpb`), each user's own WebCenter login | [INSTALL-WebCenter.md](../docs/INSTALL-WebCenter.md) |
| Remote | `src/http.ts` → `server/http.js` (Streamable HTTP) | Copilot Studio / Microsoft 365 Copilot, hosted on a Windows VM | [COPILOT-SETUP.md](../docs/COPILOT-SETUP.md) |

Remote auth modes (`MCP_AUTH_MODE`): `entra` (Microsoft sign-in verified by the server, WebCenter calls as a service account, audit-logged), `oauth` (each user's WebCenter OAuth token passed through, needs WebCenter 26.07+), `service` (API key, testing only). The remote edition leaves out `webcenter_download_document`, because it would save to the server rather than the user's computer.

## Tools

| Tool | SDK call(s) | Use |
|---|---|---|
| `webcenter_find_projects` | GetProjects | Find projects/templates by scope, name, status, recent activity |
| `webcenter_get_project` | GetProjects (details) | Folders, attributes, characteristics, related projects, permissions |
| `webcenter_list_documents` | GetDocumentList | Documents in a project: version, author, approval, viewer link |
| `webcenter_get_document_history` | GetDocumentHistory | Every version, approval stages, decisions, comments, pending approvers |
| `webcenter_get_attributes` | GetAttributes | Specs on a project, document or task, including document references |
| `webcenter_get_thumbnail` | DocumentGetThumbnailData / ProjectGetThumbnailData | Inline thumbnail image |
| `webcenter_download_document` | DownloadDocument | Save a document (e.g. .ARD) to the local download folder |
| `webcenter_get_todo_list` | GetUserTodoList | Tasks and approvals waiting on a user |
| `webcenter_find_users` | GetUsers | Users by type or name |
| `webcenter_get_user` | GetUserInfo | One user's role, company, groups |
| `webcenter_get_group` | GetGroupInfo | Group members (many projects are managed by groups) |
| `webcenter_browse_characteristics` | GetCharacteristicsTree | The project classification tree |
| `webcenter_find_projects_by_characteristic` | GetProjectsFromCharacteristics | Projects tagged with a characteristic |
| `webcenter_search` | Search | Saved or new searches (search index) |
| `webcenter_diagnostics_raw_response` | any allowlisted call | Troubleshooting: with no page, connection/session status; with a page, raw XML for field-name checks |

## Safety

- **Read-only allowlist** (`READ_ONLY_PAGES` in `src/client.ts`): any SDK page not on the list is refused before a request is made. No create, update, delete, approve or upload call is on it.
- **Credentials:** sent in an HTTPS POST body, never in a URL. Claude Desktop keeps the password in the OS keychain.
- **Sessions:** all calls share **one** WebCenter session (`OpenSession.jsp` / `CloseSession.jsp`, SDK 3.1.1), which is closed after 90 s idle and when the server stops. WebCenter allows only 5 sessions per user, browser included, and per-call logins can leave sessions behind when a call fails on the server. If `OpenSession.jsp` isn't available, it falls back to per-call logins. At most 2 calls run at once.
- **Live switch:** with `WEBCENTER_ALLOW_LIVE` off, only `localhost` or the mock can be called.
- **Downloads:** written only to the configured download folder, and never overwrite an existing file.

## Layout

```
src/client.ts             HTTP client, allowlist, XML parsing, error hints
src/lookup.ts             cached user/group/status name resolution
src/tools.ts              core tools (projects, documents, history, to-do, users, search)
src/tools-engineering.ts  engineer tools (attributes, thumbnails, downloads, groups, characteristics, diagnostics)
src/server.ts             builds the MCP server with all tools (shared by both editions)
src/index.ts              desktop entry (stdio); WEBCENTER_BASE_URL=mock starts the built-in mock
src/http.ts               remote entry (Streamable HTTP, Entra/OAuth/API-key auth, audit log)
deploy/windows/           install.ps1 / uninstall.ps1 for the Windows VM (Node, Caddy HTTPS, startup tasks)
test/http.mjs             end-to-end tests for the remote edition
mock/server.mjs           mock WebCenter returning SDK-shaped XML
test/run.mjs              end-to-end tests through a real MCP client
scripts/pack.mjs          builds the .mcpb
manifest.json             Claude Desktop extension manifest
```

## Develop

```bash
npm install
npm run build        # tsc --noEmit + esbuild bundle -> server/index.js
npm test             # end-to-end checks against the mock
npm run mock         # standalone mock at http://127.0.0.1:8765/WebCenter/ (MOCKUSER / mockpass)
npm run package      # -> dist/esko-webcenter-<version>.mcpb
npm run package-remote  # -> dist/esko-webcenter-remote-<version>.zip (VM bundle)
npm run serve        # run the remote server locally (needs env vars; WEBCENTER_BASE_URL=mock for sample data)
```

Environment variables (outside Claude Desktop): `WEBCENTER_BASE_URL` (or `mock`), `WEBCENTER_USERNAME`, `WEBCENTER_PASSWORD`, `WEBCENTER_OAUTH_TOKEN`, `WEBCENTER_SSOIID`, `WEBCENTER_ALLOW_LIVE`, `WEBCENTER_DOWNLOAD_DIR`, `WEBCENTER_TIMEOUT_MS`, `WEBCENTER_MAX_CONCURRENT`, `WEBCENTER_SESSION_MODE` (`auto` default, `session`, `per-call`), `WEBCENTER_SESSION_IDLE_MS` (default 90000).

## Adding a tool

1. Add the SDK page to `READ_ONLY_PAGES` only if it changes nothing in WebCenter.
2. Register the tool with `annotations: READ_ONLY`.
3. Add a handler to `mock/server.mjs` and checks to `test/run.mjs`.
4. If the live site's XML differs from the SDK document, check it with `webcenter_diagnostics_raw_response` and handle both names (see `pick()`).

## Not included, and why

These were tried against `abp.esko-saas.com` and left out:

- **Project tasks** (`GetProjectTasks`): the site isn't licensed for WebCenter task management ("You do not have Basic Task management license").
- **Where-used / document references** (`GetDocRefParentObjects` etc.): the site returns HTTP 500, and no document-reference attributes are in use.

## Live-site differences from the SDK document

- Project managers can be groups. The manager comes back as `<manager><group id=…><name>…</name></group></manager>`, and group IDs overlap user IDs, so `manager_type` decides which one it is.
- GetProjects returns only `status_id`. Status names come from the search index (`proj.status`) and are cached.
- GetProjects returns only attribute IDs. `webcenter_get_project` uses GetAttributes to show names.
- DateTime attributes are epoch milliseconds.
- Search (`format=json`) returns `{meta.fields, stats, results.table.rows[].cells[]}`, which is flattened to rows.
