// Builds the Claude Desktop extension (.mcpb) from manifest.json + the bundled server.
// Usage: npm run package   ->  dist/esko-webcenter-<version>.mcpb
import { mkdirSync, rmSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (!existsSync(join(root, "server", "index.js"))) throw new Error("server/index.js missing: run npm run build first");

const stage = join(root, "dist", "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
copyFileSync(join(root, "manifest.json"), join(stage, "manifest.json"));
copyFileSync(join(root, "server", "index.js"), join(stage, "server", "index.js"));
if (existsSync(join(root, "icon.png"))) copyFileSync(join(root, "icon.png"), join(stage, "icon.png"));

const out = join(root, "dist", `esko-webcenter-${manifest.version}.mcpb`);
const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");
execFileSync(bin, ["validate", join(stage, "manifest.json")], { stdio: "inherit", shell: process.platform === "win32" });
execFileSync(bin, ["pack", stage, out], { stdio: "inherit", shell: process.platform === "win32" });
rmSync(stage, { recursive: true, force: true });
console.log(`\nBuilt ${out}`);
