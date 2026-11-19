// Builds the Copilot declarative agent package (same result as copilot-agent/build-agent-package.ps1).
//   node scripts/pack-agent.mjs --server-url https://host --auth-ref <id> [--app-id <guid>] [--version 1.0.0] [--out dir]
// Also exported for the tests.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "copilot-agent", "appPackage");
export const AGENT_FILES = ["manifest.json", "declarativeAgent.json", "ai-plugin.json"];

export function fillAgentFiles({ serverUrl, authRef, appId = randomUUID(), version = "1.0.0", company = "Anchor Bay Packaging" }) {
  let url = String(serverUrl || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(url)) throw new Error("server URL must start with https://");
  if (!/\/mcp$/.test(url)) url += "/mcp";
  if (!authRef) throw new Error("auth reference ID is required");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("version must look like 1.0.0");
  const values = { TEAMS_APP_ID: appId, AGENT_VERSION: version, COMPANY_NAME: company, MCP_SERVER_URL: url, MCP_HOST: new URL(url).host, AUTH_REFERENCE_ID: authRef };
  const out = {};
  for (const f of AGENT_FILES) {
    let text = readFileSync(join(src, f), "utf8");
    for (const [k, v] of Object.entries(values)) text = text.split("${{" + k + "}}").join(JSON.stringify(v).slice(1, -1));
    const left = text.match(/\$\{\{([A-Z_]+)\}\}/);
    if (left) throw new Error(`${f} still has an unfilled placeholder: ${left[1]}`);
    out[f] = JSON.parse(text);
  }
  return { files: out, url, appId, version };
}

export function buildAgentZip(opts, outDir) {
  const { files, version } = fillAgentFiles(opts);
  const stage = mkdtempSync(join(tmpdir(), "webcenter-agent-"));
  try {
    for (const [f, json] of Object.entries(files)) writeFileSync(join(stage, f), JSON.stringify(json, null, 2) + "\n");
    for (const f of ["color.png", "outline.png"]) copyFileSync(join(src, f), join(stage, f));
    mkdirSync(outDir, { recursive: true });
    const zip = join(outDir, `esko-webcenter-agent-${version}.zip`);
    rmSync(zip, { force: true });
    execFileSync("zip", ["-qj", zip, ...[...AGENT_FILES, "color.png", "outline.png"].map((f) => join(stage, f))]);
    return zip;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const arg = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const zip = buildAgentZip(
    { serverUrl: arg("--server-url"), authRef: arg("--auth-ref"), appId: arg("--app-id"), version: arg("--version") || "1.0.0" },
    arg("--out") || join(root, "dist"),
  );
  console.log(`Built ${zip}`);
}
