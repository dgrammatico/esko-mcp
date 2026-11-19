// Builds the Azure/Windows VM bundle for the remote server: dist/esko-webcenter-remote-<version>.zip
// containing http.js (bundled server), install.ps1, uninstall.ps1 and a short README.
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!existsSync(join(root, "server", "http.js"))) throw new Error("server/http.js missing: run npm run build first");

const name = `esko-webcenter-remote-${version}`;
const stage = join(root, "dist", name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(join(root, "server", "http.js"), join(stage, "http.js"));
for (const f of ["install.ps1", "uninstall.ps1"]) copyFileSync(join(root, "deploy", "windows", f), join(stage, f));
copyFileSync(join(root, "deploy", "azure-container-apps", "deploy.ps1"), join(stage, "deploy-containerapp.ps1"));
writeFileSync(join(stage, "README.txt"), [
  `Esko WebCenter MCP server ${version} - remote (hosted) edition for Copilot Studio / Microsoft 365 Copilot`,
  "",
  "Two ways to host it. Full guide: docs/COPILOT-SETUP.md in the esko-mcp repository.",
  "",
  "OPTION A - Azure Container Apps (free tier, no server to maintain). From any PC with the Azure CLI:",
  "",
  "  Set-ExecutionPolicy -Scope Process Bypass",
  "  .\\deploy-containerapp.ps1 -TenantId <entra-tenant-id> -Audience api://<app-client-id> -RegistryUsername <github-user>",
  "",
  "OPTION B - Windows VM. On the VM, in PowerShell as Administrator, from this folder:",
  "",
  "  Set-ExecutionPolicy -Scope Process Bypass",
  "  .\\install.ps1 -Hostname <your-vm-dns-name> -TenantId <entra-tenant-id> -Audience api://<app-client-id>",
  "",
  "It asks for the WebCenter service account's username and password, which are stored only on this VM.",
  "",
  "To update the VM later, extract the new zip and run the same command again (settings are kept).",
  "",
].join("\r\n"));
const out = join(root, "dist", `${name}.zip`);
rmSync(out, { force: true });
execFileSync("zip", ["-qr", out, name], { cwd: join(root, "dist") });
rmSync(stage, { recursive: true, force: true });
console.log(`Built ${out}`);
