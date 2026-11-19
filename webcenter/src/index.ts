#!/usr/bin/env node
// Read-only MCP server for Esko WebCenter (stdio transport).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebCenterClient, loadConfig } from "./client.js";
import { Lookup } from "./lookup.js";
import { createServer } from "./server.js";

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

const lookup = new Lookup(client);
const server = createServer(client, lookup, {
  note: mockNote ? " This session is connected to a MOCK WebCenter with made-up sample data; say so when presenting results." : "",
});

await server.connect(new StdioServerTransport());

// Close the shared WebCenter session when Claude Desktop stops the server, so it doesn't hold one of the user's 5 sessions.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.race([client.close(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
console.error(`WebCenter MCP server running (read-only) against ${config.baseUrl}${mockNote}${config.allowLive ? "" : " — live calls disabled unless the site is local"}`);
