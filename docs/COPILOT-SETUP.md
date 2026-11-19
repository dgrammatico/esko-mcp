# Esko WebCenter in Microsoft 365 Copilot: setup guide

This puts the read-only WebCenter tools into the Microsoft 365 Copilot app (Copilot Chat) as an agent called **Esko WebCenter**. Engineers open Copilot, pick the agent, and ask things like *"give me the design specs for the crop excellence box."*

```
Copilot app ──(user signs in with their Microsoft work account)──► Copilot Studio agent
                                                                        │  HTTPS + Entra access token
                                                                        ▼
                         This server, read-only: Azure Container Apps (recommended, free tier) or a Windows VM
                                                                        │  WebCenter SDK, one service account
                                                                        ▼
                                                     https://abp.esko-saas.com/WebCenter/
```

**How sign-in works today:**
- **Copilot:** engineers sign in to the agent with their Microsoft work account. The server checks that sign-in on every request and accepts only your organization's accounts, optionally only an assigned group.
- **WebCenter:** the server makes its WebCenter calls with one service account, so everyone sees what that account can see. Your WebCenter is 25.07, and per-user WebCenter sign-in for SDK integrations needs 26.07 or later. See [Later: per-user WebCenter sign-in](#later-per-user-webcenter-sign-in).
- **Audit log:** every tool call is logged on the VM with the person's name. Arguments and tokens are never logged.

Allow about an hour for the whole setup. There are five parts:

1. [WebCenter service account](#1-webcenter-service-account)
2. [Entra app registration](#2-entra-app-registration)
3. [Host the server](#3-host-the-server): **[A. Azure Container Apps](#a-azure-container-apps-recommended)** (free tier, nothing to maintain) or [B. Windows VM](#b-windows-vm)
4. [Copilot Studio agent](#4-copilot-studio-agent)
5. [Billing for Copilot Chat users](#5-billing-for-copilot-chat-users)

In the steps below, `<server-url>` is the address the hosting step prints, e.g. `https://esko-webcenter-mcp.<region>.azurecontainerapps.io` or `https://abp-webcenter-mcp.eastus.cloudapp.azure.com`.

---

## 1. WebCenter service account

In WebCenter, go to **Admin → Users → New User** and create a dedicated user, e.g. `COPILOT_SVC`:

- **Password:** use a long random one, and set it not to expire (or remember to update the VM when it changes).
- **Groups:** add it to the groups whose projects engineers should be able to look up, e.g. **US ENGINEERS** and **MONTERREY ENGINEERS**. The agent can see exactly what this account can see.
- **Admin rights:** leave it a normal user unless you need the user, group and characteristic tools. Those require admin rights in WebCenter. The server can't change anything either way, because only read-only SDK calls are allowed in code.
- **Licence:** this account may use a WebCenter user licence.

## 2. Entra app registration

In the **Microsoft Entra admin center** (entra.microsoft.com), go to **App registrations → New registration**:

1. **Register the app:** name it **Esko WebCenter MCP**, choose **Single tenant**, and leave the redirect URI empty for now. Register it.
2. **Note two IDs:** from **Overview**, copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Expose an API:**
   - Next to **Application ID URI**, click **Add** and accept `api://<client-id>`.
   - Click **Add a scope**: name `access_as_user`, consent by **Admins and users**, display name "Access Esko WebCenter". Enable it.
4. **Create a secret:** under **Certificates & secrets → New client secret**, choose 24 months and copy the **Value**. Copilot Studio needs it. Set a reminder to renew it.
5. **API permissions:**
   - **Add a permission → My APIs → Esko WebCenter MCP**, then tick `access_as_user`.
   - Also add **Microsoft Graph → delegated → `offline_access`**.
   - Click **Grant admin consent**.
6. **Restrict access (recommended):** go to **Enterprise applications → Esko WebCenter MCP → Properties** and set **Assignment required** to **Yes**. Then under **Users and groups**, add the engineers' group. Anyone not assigned can't sign in to the agent.

You'll add a redirect URI from Copilot Studio in step 4.

## 3. Host the server

Choose **one** option.

### A. Azure Container Apps (recommended)

This runs the server in your own Azure subscription with HTTPS built in. It scales to zero when nobody is using it, so typical use stays inside Azure's monthly free allowance: 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests. The first question after a quiet period takes a few seconds while it starts.

You need two things:
- **Azure CLI:** `az` on your PC (already installed on yours), or use **Azure Cloud Shell** in the Azure portal.
- **A GitHub token:** the server image is published privately to GitHub's container registry by this repo's build. Create a token at **github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**. Tick **only** `read:packages`, choose an expiry (e.g. 1 year), and copy it.

Then deploy:

1. **Run the script:** from the extracted `esko-webcenter-remote-<version>.zip`, run:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\deploy-containerapp.ps1 -TenantId <tenant-id> -Audience api://<client-id> -RegistryUsername <github-username>
   ```
2. **Answer the prompts:**
   - Sign in to Azure if asked.
   - Enter the `COPILOT_SVC` username and password.
   - Paste the GitHub token.

   The password and token are stored as Container Apps **secrets**.
3. **Check the result:** the script creates the resource group `rg-esko-mcp`, the environment and the app, then checks it's answering. It ends with:
   ```
   MCP server URL for Copilot Studio:  https://esko-webcenter-mcp.<...>.azurecontainerapps.io/mcp
   ```

To keep running it:
- **Logs and audit trail:** `az containerapp logs show -n esko-webcenter-mcp -g rg-esko-mcp --follow`
- **Update to a new version:** `.\deploy-containerapp.ps1 -ImageOnly -Image ghcr.io/dgrammatico/esko-webcenter-mcp:<version>`
- **Change settings or the password:** run the full command again.
- **Budget alert:** set one in **Cost Management → Budgets** (e.g. $5/month). Azure doesn't cap spending automatically once usage goes past the free allowance.
- **Remove it:** `az group delete -n rg-esko-mcp`

### B. Windows VM

Use this if you'd rather run it on a VM you already have.

**Networking**, in the Azure portal:

1. Open the VM's **public IP address** resource. Under **Configuration**, set a **DNS name label**, e.g. `abp-webcenter-mcp`, then save. Your address becomes something like `abp-webcenter-mcp.eastus.cloudapp.azure.com`. This guide calls it `<vm-dns-name>`.
2. Open the VM's **network security group**. Under **Inbound security rules**, add a rule allowing **TCP 443** from Any, and another allowing **TCP 80** from Any.
   - **443** carries the actual traffic.
   - **80** is only used to issue and renew the free HTTPS certificate, and to redirect to HTTPS.

**Install**:

1. **Copy the bundle:** get `esko-webcenter-remote-<version>.zip` from the GitHub release. Copy it to the VM (copy and paste through Remote Desktop works) and extract it.
2. **Run the installer:** open **PowerShell as Administrator** in the extracted folder and run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1 -Hostname <vm-dns-name> -TenantId <tenant-id> -Audience api://<client-id>
   ```

   Enter the `COPILOT_SVC` username and password when asked. They're stored only on the VM, in `C:\EskoMCP\config.env`, which only Administrators and SYSTEM can read.
3. **Check the result:** the installer finishes by testing the server. You should see:
   ```
   HTTPS works: https://<vm-dns-name>/healthz
   MCP server URL for Copilot Studio:  https://<vm-dns-name>/mcp
   ```
   You can also open `https://<vm-dns-name>/healthz` in any browser. It should say `"ok":true`.

What the installer sets up:
- **`C:\EskoMCP`:** the server, a private Node.js, and Caddy, which handles HTTPS with a free, auto-renewing certificate.
- **Startup tasks:** two scheduled tasks, **EskoMCP-Server** and **EskoMCP-Caddy**, that start at boot and restart themselves if they stop.
- **Firewall:** Windows Firewall rules for ports 80 and 443.
- **Logs:** written to `C:\EskoMCP\logs\`. The audit lines in `server.log` look like `user=jdoe@anchorbaypackaging.com tool=webcenter_get_attributes`.

**Updating:** extract the new zip and run the same `install.ps1` command again. Your settings are kept.
**Uninstalling:** run `.\uninstall.ps1`, adding `-DeleteFiles` to also remove `C:\EskoMCP`.

## 4. Copilot Studio agent

In **Copilot Studio** (copilotstudio.microsoft.com):

1. **Create the agent:** click **Create → New agent**, then skip the conversational setup and configure it directly.
   - **Name:** Esko WebCenter
   - **Description:** Look up packaging projects, ArtiosCAD design specs, documents and approvals in Esko WebCenter (read-only).
   - **Instructions:** paste these:
     > You help Anchor Bay Packaging engineers look things up in Esko WebCenter. You can only read data; you can't change anything in WebCenter.
     > To find a project by its description (e.g. "crop excellence box"), use webcenter_search with new_search "proj", columns proj.name, proj.description, proj.status and filter(proj.description).query set to the words wrapped in asterisks, e.g. "*crop excellence*". To find by project number use webcenter_find_projects with scope all_by_name.
     > For design specs, get the project (webcenter_get_project), list its documents (webcenter_list_documents), and read the attributes of the main design (webcenter_get_attributes with the document_id). Report style, L x W x D, board, flute, joint, print, mill scores (convert mm to inches), revision history and who designed it.
     > If several projects match, show them and say which looks current (e.g. released for production, most recently modified). Never invent values; say when a field is empty.
   - **Web search:** turn **off** "Use general knowledge" and web search if you want answers to come only from WebCenter.
2. **Add the WebCenter tool:** go to **Tools → Add a tool → New tool → Model Context Protocol** and fill in:

   | Field | Value |
   |---|---|
   | Server name | Esko WebCenter |
   | Server description | Read-only access to Esko WebCenter projects, documents, ArtiosCAD design specs, approvals and users. |
   | Server URL | `<server-url>/mcp` |
   | Authentication | **OAuth 2.0**, type **Manual** |
   | Client ID | the Application (client) ID from step 2 |
   | Client secret | the secret Value from step 2 |
   | Authorization URL | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize` |
   | Token URL template | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` |
   | Refresh URL | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` |
   | Scopes | `api://<client-id>/access_as_user offline_access` |

   Click **Create**. Copilot Studio then shows a **callback (redirect) URL**: copy it.
3. **Add the callback URL in Entra:** back in the Entra admin center, open **App registrations → Esko WebCenter MCP → Authentication → Add a platform → Web**, paste the callback URL, and save.
4. **Connect:** in Copilot Studio, choose **Create a new connection** and sign in with your work account. The tool's 14 WebCenter tools should then appear. Add the tool to the agent.
5. **Test:** in the **Test** pane, ask *"Give me the design specs for the project with description crop excellence box."* You should get AT13294.1B, an RSC 14-1/2 × 9-1/4 × 14-1/2.
6. **Publish:** click **Publish**. Then go to **Channels → Teams and Microsoft 365 Copilot**, turn on **Make agent available in Microsoft 365 Copilot**, and add the channel.
7. **Make it available:** under **Availability options**, choose **Show to everyone in my org**, or submit it for admin approval. Approve it in the **Microsoft 365 admin center → Agents** (or **Settings → Integrated apps**). You can **deploy and pin** it for the engineers' group so it shows up in their Copilot app without searching.

The first time an engineer uses the agent, Copilot asks them to sign in. After that it just works.

## 5. Billing for Copilot Chat users

Your engineers use the free Copilot Chat, without the paid Microsoft 365 Copilot licence. For them, conversations with a Copilot Studio agent are billed in **Copilot Credits**. Set this up in the **Microsoft 365 admin center** or the **Power Platform admin center** with one of these:

- **Pay-as-you-go:** link an Azure subscription and set a monthly budget.
- **Prepaid Copilot Credit packs**

Turn on usage alerts so there are no surprises. Users with a paid Microsoft 365 Copilot licence aren't charged for agent use.

## Troubleshooting

| Symptom | Check |
|---|---|
| `<server-url>/healthz` doesn't load | Container Apps: `az containerapp logs show -n esko-webcenter-mcp -g rg-esko-mcp --tail 50`. VM: NSG allows 443 and 80, the DNS label resolves to the VM, and see `C:\EskoMCP\logs\caddy.log` |
| Copilot Studio says the connection failed | Callback URL added in Entra (step 4.3); scopes exactly `api://<client-id>/access_as_user offline_access`; admin consent granted |
| "Microsoft sign-in token rejected (ERR_JWT_CLAIM_VALIDATION_FAILED)" in a tool error | `-Audience` matches the Application ID URI; rerun the deploy/install command (VM: add `-Reconfigure`) |
| A user can't sign in | They're assigned to the enterprise app (step 2.6) |
| `WebCenter error 001` | The service account's password changed: rerun the deploy command (VM: `install.ps1 ... -Reconfigure`) |
| `WebCenter error 004` | Too many sessions for the service account; the server uses only one, so check nothing else logs in as `COPILOT_SVC` |
| Container app won't start: "unauthorized" pulling the image | The GitHub token expired or lacks `read:packages`: rerun the deploy command with a new token |
| Anything else | Server logs (see above); ask the agent to run `webcenter_diagnostics_raw_response` with no page for a connection report |

## Later: per-user WebCenter sign-in

Once Esko moves your site to WebCenter **26.07 or later** and enables the **OAuth SSO plugin for SDK authentication**, each engineer can sign in to WebCenter as themselves. They'd then see only what their own account can see, and the service account is no longer needed:

1. **WebCenter:** in the new OAuth admin page, create a client and add Copilot Studio's callback URL as its redirect URL.
2. **The server:** redeploy in OAuth mode, with `.\deploy-containerapp.ps1 -AuthMode oauth -RegistryUsername <github-username>` (Container Apps) or `.\install.ps1 -Hostname <vm-dns-name> -AuthMode oauth -Reconfigure` (VM).
3. **Copilot Studio:** change the tool's OAuth settings to WebCenter's client ID, secret and authorization/token URLs.

The server already supports this mode (`MCP_AUTH_MODE=oauth`), and it's covered by the automated tests.
