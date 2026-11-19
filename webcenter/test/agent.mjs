// Checks the Copilot declarative agent package: placeholders fill in, files are valid and consistent,
// and the result follows the documented schema rules (app manifest 1.21, declarative agent 1.6, plugin 2.4).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fillAgentFiles, buildAgentZip } from "../scripts/pack-agent.mjs";

let pass = 0, fail = 0;
const check = (name, ok, info = "") => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };

console.log("Copilot agent package");
const appId = "11111111-2222-3333-4444-555555555555";
const { files, url } = fillAgentFiles({ serverUrl: "https://esko-webcenter-mcp.example.eastus.azurecontainerapps.io/", authRef: "ref\"with=quote", appId, version: "1.0.3" });
const m = files["manifest.json"], da = files["declarativeAgent.json"], p = files["ai-plugin.json"];

check("/mcp is appended to the server URL", url === "https://esko-webcenter-mcp.example.eastus.azurecontainerapps.io/mcp", url);
check("manifest: app id, version, 1.21", m.id === appId && m.version === "1.0.3" && m.manifestVersion === "1.21");
check("manifest: short name <= 30, short description <= 80, full <= 4000", m.name.short.length <= 30 && m.description.short.length <= 80 && m.description.full.length <= 4000);
check("manifest: developer URLs are https", Object.entries(m.developer).filter(([k]) => k.endsWith("Url")).every(([, v]) => v.startsWith("https://")));
check("manifest: points at declarativeAgent.json", m.copilotAgents.declarativeAgents[0].file === "declarativeAgent.json");
check("manifest: validDomains is the server host", m.validDomains[0] === "esko-webcenter-mcp.example.eastus.azurecontainerapps.io");
check("agent: schema v1.6, name <= 100, description <= 1000", da.version === "v1.6" && da.name.length <= 100 && da.description.length <= 1000);
check("agent: instructions under 8000 characters", da.instructions.length < 8000, String(da.instructions.length));
check("agent: 1-12 conversation starters with unique titles", da.conversation_starters.length >= 1 && da.conversation_starters.length <= 12 && new Set(da.conversation_starters.map((c) => c.title)).size === da.conversation_starters.length);
check("agent: one action pointing at ai-plugin.json", da.actions.length === 1 && da.actions[0].file === "ai-plugin.json");
check("agent: instructions say read-only", /cannot create, change, approve or delete/.test(da.instructions));
check("plugin: v2.4, namespace alphanumeric", p.schema_version === "v2.4" && /^[A-Za-z0-9]+$/.test(p.namespace));
check("plugin: description_for_human <= 100", p.description_for_human.length <= 100);
const rt = p.runtimes[0];
check("plugin: RemoteMCPServer with dynamic tool discovery", rt.type === "RemoteMCPServer" && p.functions.length === 0 && rt.run_for_functions[0] === "*" && rt.spec.url === url);
check("plugin: OAuthPluginVault with the reference id (JSON-escaped)", rt.auth.type === "OAuthPluginVault" && rt.auth.reference_id === "ref\"with=quote");

// every tool the instructions mention exists on the remote server
const srcText = ["tools.ts", "tools-engineering.ts"].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
const mentioned = [...new Set(da.instructions.match(/webcenter_[a-z_]+/g))];
const missing = mentioned.filter((t) => !srcText.includes(`"${t}"`));
check(`instructions only name real tools (${mentioned.length})`, missing.length === 0, missing.join(","));
check("instructions don't rely on the desktop-only download tool", !mentioned.includes("webcenter_download_document"));

let threw = false; try { fillAgentFiles({ serverUrl: "http://insecure", authRef: "x" }); } catch { threw = true; }
check("rejects a non-https server URL", threw);
threw = false; try { fillAgentFiles({ serverUrl: "https://x", authRef: "" }); } catch { threw = true; }
check("requires the auth reference id", threw);

const dir = mkdtempSync(join(tmpdir(), "agent-zip-"));
try {
  const zip = buildAgentZip({ serverUrl: "https://host.example.com", authRef: "abc", appId, version: "1.0.0" }, dir);
  const list = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n").sort();
  check("zip has the five files at its root", JSON.stringify(list) === JSON.stringify(["ai-plugin.json", "color.png", "declarativeAgent.json", "manifest.json", "outline.png"]), list.join(","));
  const sizes = (f) => { const b = execFileSync("unzip", ["-p", zip, f]); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  check("icons are 192x192 and 32x32", JSON.stringify(sizes("color.png")) === "[192,192]" && JSON.stringify(sizes("outline.png")) === "[32,32]");
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
