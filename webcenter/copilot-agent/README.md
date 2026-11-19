# WebCenter agent for Microsoft 365 Copilot (declarative agent)

This folder builds the **WebCenter** agent that engineers use in the Microsoft 365 Copilot app (Copilot Chat). It's a declarative agent: Copilot's own model, these instructions, and one action, an MCP plugin pointing at the hosted WebCenter MCP server. For Copilot Chat users it's designed to run without Copilot Studio or usage charges.

| File | What it is |
|---|---|
| `appPackage/manifest.json` | Microsoft 365 app manifest (v1.21): name, icons, app ID |
| `appPackage/declarativeAgent.json` | Agent instructions and conversation starters (schema v1.6) |
| `appPackage/ai-plugin.json` | MCP plugin (schema v2.4): server URL, sign-in reference, dynamic tool discovery |
| `appPackage/color.png`, `outline.png` | Icons (192×192, 32×32) |
| `build-agent-package.ps1` | Fills in your values and builds the upload zip (Windows PowerShell 5.1 or 7) |

Placeholders like `${{MCP_SERVER_URL}}` are filled in by the build script, so the same files also work with Microsoft 365 Agents Toolkit if you prefer it.

## Build

```powershell
.\build-agent-package.ps1 -ServerUrl https://<your-server> -AuthReferenceId <Microsoft Entra SSO registration ID>
```

This creates `esko-webcenter-agent-<version>.zip` and remembers the settings, including the agent's app ID, in `agent-settings.json`. Keep that file. To rebuild later, run `.\build-agent-package.ps1 -Version 1.0.1`.

The full walkthrough, covering SSO registration, the Entra changes, upload and rollout, is in **docs/COPILOT-SETUP.md, step 4A**.

## Changing what the agent says

Edit `instructions` or `conversation_starters` in `appPackage/declarativeAgent.json`, rebuild with a higher `-Version`, and upload the zip as an update in the Microsoft 365 admin center. New server tools need no rebuild: the agent discovers the server's tools at runtime.

From the repo you can also build and check it with Node: `npm run package-agent -- --server-url https://<server> --auth-ref <id>`. To run the checks only, use `node test/agent.mjs`.
