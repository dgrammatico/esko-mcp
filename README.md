# esko-mcp

MCP servers that connect Claude to Esko systems natively.

| Folder | What it is | Status |
|---|---|---|
| [`webcenter/`](webcenter/) | **Esko WebCenter (read-only)**: projects, documents and ArtiosCAD designs, specs, approvals, thumbnails, downloads | 1.0.0, live |

## Install

- **Claude Desktop (each engineer):** download `esko-webcenter-<version>.mcpb` from [Releases](../../releases) and follow [docs/INSTALL-WebCenter.md](docs/INSTALL-WebCenter.md).
- **Microsoft 365 Copilot (IT, once):** host the remote edition on Azure Container Apps (free tier) or a Windows VM, then upload the **WebCenter** declarative agent (no usage charges), by following [docs/COPILOT-SETUP.md](docs/COPILOT-SETUP.md). The scripts are in `esko-webcenter-remote-<version>.zip`.

## Develop

```bash
cd webcenter
npm install
npm run build     # type-check + bundle
npm test          # end-to-end checks against the built-in mock WebCenter
npm run package   # -> dist/esko-webcenter-<version>.mcpb
```

CI runs build, test and package on every push to `webcenter/`, and publishes the remote-edition container to `ghcr.io/dgrammatico/esko-webcenter-mcp` (private). Pushing a tag like `webcenter-v1.2.1` publishes a GitHub release with the `.mcpb` and the remote bundle attached, and tags the image `1.2.1` and `latest`.

## Not in this repo

Esko's SDK documentation and API description are licensed Esko material. They're kept out of this repo on purpose. Ask IT for them.
