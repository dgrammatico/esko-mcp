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
