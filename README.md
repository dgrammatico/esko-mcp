# esko-mcp

MCP servers that connect Claude to Anchor Bay Packaging's Esko systems.

| Folder | What it is | Status |
|---|---|---|
| [`webcenter/`](webcenter/) | **Esko WebCenter (read-only)**: projects, documents and ArtiosCAD designs, specs, approvals, thumbnails, downloads | 1.0.0, in use |

## Install

- **Claude Desktop (each engineer):** download `esko-webcenter-<version>.mcpb` from [Releases](../../releases) and follow [docs/INSTALL-WebCenter.md](docs/INSTALL-WebCenter.md).
- **Microsoft 365 Copilot (IT, once):** host `esko-webcenter-remote-<version>.zip` on a Windows VM and publish a Copilot Studio agent by following [docs/COPILOT-SETUP.md](docs/COPILOT-SETUP.md).

## Develop

```bash
cd webcenter
npm install
npm run build     # type-check + bundle
npm test          # end-to-end checks against the built-in mock WebCenter
npm run package   # -> dist/esko-webcenter-<version>.mcpb
```

CI runs build, test and package on every push to `webcenter/`. Pushing a tag like `webcenter-v1.0.1` publishes a GitHub release with the `.mcpb` attached.

## Not in this repo

Esko's SDK documentation and API description are licensed Esko material. They're kept out of this repo on purpose. Ask IT for them.
