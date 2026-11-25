# Installing Esko WebCenter tools for Claude

This adds read-only WebCenter access to Claude Desktop.

## prequisites:

- Claude Desktop on Win/mac
- an active webcenter subscription or account and login

## Install

1. Download **`esko-webcenter-<version>.mcpb`** from Releases
2. In Claude Desktop, open **Settings** (Win: Ctrl + comma) → **Extensions**.
3. Click **Advanced settings** → **Install Extension…** and pick the `.mcpb` file.
4. Click **Install**, then fill into the config:

   | Setting | What to enter |
   |---|---|
   | WebCenter address | Leave as `https://yourdomain.esko-saas.com/WebCenter/` |
   | Username |  WebCenter username |
   | Password |  WebCenter password. stored in system keychain |
   | Download folder path | optional, defaults to `Downloads\WebCenter`. |
   | Basic login SSO instance ID | Leave blank unless you use SSO. |
   | Allow live WebCenter | Leave on, turn off for debugging/testing purposes |

5. Enable the extension in Plugins
6. Start a session

## Updates

Install the new `.mcpb` and replace

## Troubleshooting

| Msg | rec |
|---|---|
| `WebCenter error 001: User login failed` | Wrong username or password.  |
| `error 004 … maximum of 5 open WebCenter sessions` | No available sessions, log out or wait for a session to time out. max 30min. |
| `error 005 … privileges` | requires webcenter admin privilege to see |
| `returned a web page instead of SDK data` | Response if SSO instance is used without being configured. |
| `Live WebCenter calls are switched off` | Using debugging dataset instead of live, switch in settings. |
| no tools visible to agent | ensure proper installation and restart client. |

## permissions

some tools will need admin or project manager rights and will notify before the tool call goes through.
