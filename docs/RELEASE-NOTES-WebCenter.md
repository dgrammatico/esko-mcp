## Esko WebCenter MCP 1.2.0

**New: Microsoft 365 Copilot edition.** A hosted version of the server for Copilot Studio and the Microsoft 365 Copilot app, with two ways to host it:
- **Azure Container Apps (recommended):** one deploy script. It scales to zero, fits the free tier, has HTTPS built in, and stores its secrets in Container Apps.
- **Windows VM:** one install script, with HTTPS and an automatic certificate, auto-start and a health check.
- Engineers sign in with their Microsoft work account. The server verifies every request and can be limited to an assigned group.
- WebCenter calls run as one read-only service account, because per-user WebCenter sign-in needs WebCenter 26.07 or later, and that mode is already built in.
- Every tool call is audit-logged with the user's name.
- Setup guide: `COPILOT-SETUP.md`. Scripts: `esko-webcenter-remote-1.2.0.zip`. Container image: `ghcr.io/dgrammatico/esko-webcenter-mcp:1.2.0`.

The Claude Desktop extension is unchanged apart from the version number.

## Esko WebCenter MCP 1.1.1

**Connection status in the troubleshooting tool.** Run `webcenter_diagnostics_raw_response` with no page to see whether the extension is using a shared session or per-call logins, whether a session is open, and session counters.

## Esko WebCenter MCP 1.1.0

**One WebCenter session instead of one per request.** Each request used to sign in and out on its own, and requests that failed on WebCenter's side could leave sessions open. Those count toward your 5-session limit and cause "error 004". Now all requests share one session, which closes after 90 seconds of inactivity and when Claude stops the extension. If a session expires, it reopens automatically. If your site doesn't support shared sessions, it falls back to the old behaviour.

The error 004 message now explains that you need to log out of WebCenter in the browser (closing the tab isn't enough), or wait about 30 minutes.

## Esko WebCenter MCP 1.0.0

First release for engineers. Read-only: nothing in WebCenter can be changed through it.

**15 tools:** projects, project details, documents, document history and approvals, attributes/specs, thumbnails, downloads (to your computer), to-do list, users, groups, characteristics, projects by characteristic, search, and a troubleshooting tool.

**Fixed since the first live test:**
- Document lists now show each document's version number.
- Projects managed by a group now show the group's name instead of an ID.
- Group-managed projects are no longer mistaken for a user with the same ID.
- Project status names are shown (e.g. "Active").
- Project details show attribute names, not just IDs. Empty attributes are hidden, and dates are readable.
- Search results are returned as simple rows.

**Install:** download `esko-webcenter-1.0.0.mcpb` below and follow `INSTALL-WebCenter.md`.

**Not included:** project tasks (your WebCenter isn't licensed for task management) and where-used lookups (WebCenter returns a server error).
