## Esko WebCenter MCP 1.2.1

remote zip now has a `copilot-agent` folder that builds a **declarative agent** called **WebCenter** for Microsoft 365 Copilot
- It calls the hosted server through an MCP plugin.
- Entra is used for sign in.
-  `build-agent-package.ps1` builds the zip package upload to host.
- See `COPILOT-SETUP.md`

Other changes:
- `deploy-containerapp.ps1 -AddAudience <uri>` adds an accepted token audience without redeploying or re-entering secrets.
- `-Audience` (both scripts) now accepts a comma-separated list.

## Esko WebCenter MCP 1.2.0

- **Azure Container Apps (recommended):** deploy script for hosting on azure app service/container apps
- **Windows VM:** deploy script for hosting on azure VM. contains auth certificate and https.
- Setup: `COPILOT-SETUP.md`. Script: `esko-webcenter-remote-1.2.0.zip`. Container image: `ghcr.io/dgrammatico/esko-webcenter-mcp:1.2.0`.


## Esko WebCenter MCP 1.1.1

**Connection status in the troubleshooting tool.** Run `webcenter_diagnostics_raw_response` with no page to see whether the extension is using a shared session or per call logins

## Esko WebCenter MCP 1.1.0

**One WebCenter session instead of one per request.** all requests share one session, with a 90 sec activity timeout. also closes if the agent stops the extension. If a session expires, it reopens automatically. if shared sessions are not supported on another version it will open one for each tool call.

The error 004 message now explains that you need to log out of WebCenter.

## Esko WebCenter MCP 1.0.0

First release, includes read only engineering tools.

**15 tools:** projects, project details, documents, document history and approvals, attributes/specs, thumbnails, downloads, to-do list, users, groups, characteristics, projects by characteristic, search, troubleshooting tool.

**Fixed**
- Document lists now show version number.
- Projects managed by a group now show the group's name instead of an ID.
- Group-managed projects are no longer mistaken for a user with the same ID.
- Project status names are shown (e.g. "Active").
- Project details show attribute names and ID
- dates are formatted.
- Search results are returned as rows.

**Install:** download `esko-webcenter-1.0.0.mcpb` below, follow `INSTALL-WebCenter.md`.

