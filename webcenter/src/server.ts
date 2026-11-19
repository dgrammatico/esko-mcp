// Builds the MCP server with all WebCenter tools. Shared by the desktop (stdio) and remote (HTTP) entry points.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebCenterClient } from "./client.js";
import { registerTools } from "./tools.js";
import { registerEngineeringTools } from "./tools-engineering.js";
import { Lookup } from "./lookup.js";
import { SERVER_VERSION } from "./version.js";

export interface ServerOptions {
  /** Remote (hosted) mode: tools that act on the local computer, like downloads, are left out. */
  remote?: boolean;
  /** Extra note added to the instructions, e.g. when connected to the mock. */
  note?: string;
}

export function createServer(client: WebCenterClient, lookup: Lookup, opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "webcenter", version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to Esko WebCenter (packaging projects, documents including ArtiosCAD designs, approvals, tasks and users). " +
        "Typical flow: webcenter_search (to find a project by description) or webcenter_find_projects (by name) -> webcenter_get_project or webcenter_list_documents -> " +
        "webcenter_get_attributes (design specs) or webcenter_get_document_history. " +
        "IDs look like 00002_0000000135. Nothing here can change data in WebCenter." +
        (opts.note ?? ""),
    },
  );
  registerTools(server, client, lookup);
  registerEngineeringTools(server, client, lookup, { remote: !!opts.remote });
  return server;
}
