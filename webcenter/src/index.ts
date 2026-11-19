#!/usr/bin/env node
// Read-only MCP server for Esko WebCenter (stdio transport).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebCenterClient, loadConfig } from "./client.js";
import { registerTools } from "./tools.js";
import { registerEngineeringTools } from "./tools-engineering.js";
import { Lookup } from "./lookup.js";

// WEBCENTER_BASE_URL=mock starts the built-in mock WebCenter, so the server can be tried with no real site.
let mockNote = "";
if ((process.env.WEBCENTER_BASE_URL || "").trim().toLowerCase() === "mock") {
  // @ts-ignore - plain JS module
  const { startMock } = await import("../mock/server.mjs");
  const { baseUrl } = await startMock(0);
  process.env.WEBCENTER_BASE_URL = baseUrl;
  process.env.WEBCENTER_USERNAME = "MOCKUSER";
  process.env.WEBCENTER_PASSWORD = "mockpass";
  delete process.env.WEBCENTER_OAUTH_TOKEN;
  mockNote = " (built-in mock with sample data — not your real WebCenter)";
}

const config = loadConfig();
const client = new WebCenterClient(config);

const server = new McpServer(
  { name: "webcenter", version: "1.0.0" },
  {
    instructions:
      "Read-only access to Esko WebCenter (packaging projects, documents including ArtiosCAD designs, approvals, tasks and users). " +
      "Typical flow: webcenter_find_projects -> webcenter_get_project or webcenter_list_documents -> webcenter_get_document_history. " +
      "IDs look like 00002_0000000135. Nothing here can change data in WebCenter." +
      (mockNote ? " This session is connected to a MOCK WebCenter with made-up sample data; say so when presenting results." : ""),
  },
);

const lookup = new Lookup(client);
registerTools(server, client, lookup);
registerEngineeringTools(server, client, lookup);

await server.connect(new StdioServerTransport());
console.error(`WebCenter MCP server running (read-only) against ${config.baseUrl}${mockNote}${config.allowLive ? "" : " — live calls disabled unless the site is local"}`);
