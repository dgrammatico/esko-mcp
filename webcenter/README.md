# Esko WebCenter MCP server (read-only)

A Claude Desktop extension that gives Claude read-only access to Esko WebCenter through the WebCenter SDK (JSP calls over HTTPS). Built from the *WebCenter 26.07 SDK* document and verified against `abp.esko-saas.com`.

End-user install guide: [../docs/INSTALL-WebCenter.md](../docs/INSTALL-WebCenter.md)

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
| `webcenter_diagnostics_raw_response` | any allowlisted call | Troubleshooting: raw XML for field-name checks |

## Safety

- **Read-only allowlist** (`READ_ONLY_PAGES` in `src/client.ts`): any SDK page not on the list is refused before a request is made. No create, update, delete, approve or upload call is on it.
- **Credentials:** sent in an HTTPS POST body, never in a URL. Claude Desktop keeps the password in the OS keychain.
- **Sessions:** at most 2 concurrent calls, because WebCenter allows 5 sessions per user, browser included.
- **Live switch:** with `WEBCENTER_ALLOW_LIVE` off, only `localhost` or the mock can be called.
- **Downloads:** written only to the configured download folder, and never overwrite an existing file.

## Layout

```
src/client.ts             HTTP client, allowlist, XML parsing, error hints
src/lookup.ts             cached user/group/status name resolution
src/tools.ts              core tools (projects, documents, history, to-do, users, search)
src/tools-engineering.ts  engineer tools (attributes, thumbnails, downloads, groups, characteristics, diagnostics)
src/index.ts              server entry; WEBCENTER_BASE_URL=mock starts the built-in mock
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
```

Environment variables (outside Claude Desktop): `WEBCENTER_BASE_URL` (or `mock`), `WEBCENTER_USERNAME`, `WEBCENTER_PASSWORD`, `WEBCENTER_OAUTH_TOKEN`, `WEBCENTER_SSOIID`, `WEBCENTER_ALLOW_LIVE`, `WEBCENTER_DOWNLOAD_DIR`, `WEBCENTER_TIMEOUT_MS`, `WEBCENTER_MAX_CONCURRENT`.

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
