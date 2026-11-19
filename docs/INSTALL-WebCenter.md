# Installing the Esko WebCenter tools for Claude

This adds read-only WebCenter access to Claude Desktop, so you can ask things like:

- "What's the latest version of the CASM design in A40491.2C, and who uploaded it?"
- "Show me the specs on project ABP4141.3A."
- "Which projects are managed by US ENGINEERS, and who's in that group?"
- "Find all ArtiosCAD designs starting with A40491."
- "Show me a thumbnail of A40491.2BPTA.ARD."
- "Download the latest A40491.2CASM.ARD so I can open it in ArtiosCAD."
- "What's waiting on me in WebCenter?"

It **can't change anything in WebCenter**. It only reads. Downloads are saved to a folder on your own computer.

## What you need

- Claude Desktop on Windows or Mac, signed in
- Your WebCenter username and password (the same ones you use at https://abp.esko-saas.com/WebCenter/)

## Install

1. Download **`esko-webcenter-<version>.mcpb`** from the repo's Releases page, or get it from IT.
2. In Claude Desktop, open **Settings** (Ctrl + comma on Windows) → **Extensions**.
3. Click **Advanced settings** → **Install Extension…** and pick the `.mcpb` file.
   (Double-clicking the file may also work, if your computer knows to open `.mcpb` files with Claude.)
4. Click **Install**, then fill in:

   | Setting | What to enter |
   |---|---|
   | WebCenter address | Leave as `https://abp.esko-saas.com/WebCenter/` |
   | Username | Your WebCenter username |
   | Password | Your WebCenter password. It's stored in your system keychain. |
   | Download folder | Optional. Defaults to `Downloads\WebCenter`. |
   | Basic login SSO instance ID | Leave empty unless IT tells you otherwise |
   | Allow live WebCenter | Leave on |

5. Make sure the extension's switch is **on**.
6. Start a new chat and ask: *"What's on my WebCenter to-do list?"*

## Updating

Install the new `.mcpb` the same way. It replaces the old version.

## Troubleshooting

| Message | Fix |
|---|---|
| `WebCenter error 001: User login failed` | Wrong username or password. Re-enter them in Settings → Extensions → Esko WebCenter. |
| `error 004 … maximum of 5 open WebCenter sessions` | Close some WebCenter browser tabs, or wait a few minutes. |
| `error 005 … privileges` | Your WebCenter account can't see that. Ask a WebCenter admin. |
| `returned a web page instead of SDK data` | Single sign-on is involved. Ask IT for the SSO instance ID. |
| `Live WebCenter calls are switched off` | Turn on "Allow live WebCenter" in the extension settings. |
| The tools don't appear in Claude | Check the extension is switched on, then start a new chat. |

## What it can see

Exactly what your WebCenter account can see, nothing more. Some tools (finding users, groups, projects by characteristic) need admin or project-manager rights and will say so if you don't have them.
