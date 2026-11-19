# Esko WebCenter in Microsoft 365 Copilot: setup guide

This puts the read-only WebCenter tools into the Microsoft 365 Copilot app (Copilot Chat) as an agent called **Esko WebCenter**. Engineers open Copilot, pick the agent, and ask things like *"give me the design specs for the crop excellence box."*

```
Copilot app ──(user signs in with their Microsoft work account)──► "WebCenter" agent (declarative agent)
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

Allow about an hour for the whole setup. There are four parts:

1. [WebCenter service account](#1-webcenter-service-account)
2. [Entra app registration](#2-entra-app-registration)
3. [Host the server](#3-host-the-server): **[A. Azure Container Apps](#a-azure-container-apps-recommended)** (free tier, nothing to maintain) or [B. Windows VM](#b-windows-vm)
4. [The Copilot agent](#4-the-copilot-agent): **[A. Declarative agent](#4a-declarative-agent-recommended-no-usage-charges)** (recommended: no usage charges) or [B. Copilot Studio agent](#4b-copilot-studio-agent-billed-per-use) (billed per use)

**Cost:** with 3A and 4A the whole setup is designed to cost nothing: Container Apps' free allowance covers the hosting, and a declarative agent whose only tool is an external MCP server isn't metered for Copilot Chat users (only agents grounded in SharePoint or Graph connector data are). Metered agents are off by default, so as long as nobody sets up pay-as-you-go billing for Copilot, there's nothing to charge. If an agent ever needed billing, it would show as unavailable rather than send a bill.

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
4. **Create a secret (only for 4B, Copilot Studio):** under **Certificates & secrets → New client secret**, choose 24 months and copy the **Value**. Set a reminder to renew it. Skip this for the declarative agent (4A).
5. **API permissions:**
   - **Add a permission → My APIs → Esko WebCenter MCP**, then tick `access_as_user`.
   - Also add **Microsoft Graph → delegated → `offline_access`**.
   - Click **Grant admin consent**.
6. **Restrict access (recommended):** go to **Enterprise applications → Esko WebCenter MCP → Properties** and set **Assignment required** to **Yes**. Then under **Users and groups**, add the engineers' group. Anyone not assigned can't sign in to the agent.

You'll add a redirect URI and a second Application ID URI in step 4.

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
   MCP server URL:  https://esko-webcenter-mcp.<...>.azurecontainerapps.io/mcp
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

## 4. The Copilot agent

### 4A. Declarative agent (recommended, no usage charges)

This is a small app package: agent instructions plus a plugin that points Copilot at your server. It runs on Copilot's built-in model, signs engineers in with their work account automatically (Entra single sign-on), and needs no Copilot Studio and no billing setup. Everything is in the remote zip's `copilot-agent` folder.

Before you start, have these to hand:
- **The server address** from step 3, e.g. `https://esko-webcenter-mcp.<...>.azurecontainerapps.io`.
- **The two IDs** from step 2: the Application (client) ID and the Directory (tenant) ID.

**1. Register single sign-on for the agent.** Open the **Teams Developer Portal** (dev.teams.microsoft.com) and go to **Tools → Microsoft Entra SSO client ID registration → Register client ID** (or **New client registration**). Fill in:

| Field | Value |
|---|---|
| Registration name | Esko WebCenter MCP |
| Base URL | `<server-url>/mcp` |
| Restrict usage by org | **My organization only** |
| Restrict usage by app | **Any Teams app** for now (you can bind it to the agent's app ID after step 5) |
| Client ID | the Application (client) ID from step 2 |
| Scope | `api://<client-id>/access_as_user` |

Save. Copy the two values it shows:
- **Microsoft Entra SSO registration ID**: this goes into the agent package.
- **Application ID URI**: it looks like `api://auth-<guid>/<client-id>`.

**2. Update the Entra app registration.** In the Entra admin center, open **App registrations → Esko WebCenter MCP**:
1. **Add the second Application ID URI:** open **Manifest**, find `"identifierUris"` and add the Application ID URI from step 1, keeping the existing one. For example, `["api://<client-id>", "api://auth-<guid>/<client-id>"]`. Save. The portal's Expose an API page only shows the first URI; that's normal.
2. **Add the redirect URI:** go to **Authentication → Add a platform → Web** (or add to the existing Web platform) and enter `https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect`. Save.
3. **Authorize Microsoft's token store:** go to **Expose an API → Add a client application**, enter `ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b` (the Microsoft Enterprise Token Store), tick the `access_as_user` scope, and add it.

**3. Tell the server to accept the new audience.** Copilot's tokens will be issued for the new Application ID URI.
- **Container Apps:** from the extracted remote zip folder, run:
  ```powershell
  .\deploy-containerapp.ps1 -AddAudience api://auth-<guid>/<client-id>
  ```
  This changes only that one setting. It doesn't ask for passwords.
- **Windows VM:** run the installer again with both audiences:
  ```powershell
  .\install.ps1 -Hostname <vm-dns-name> -TenantId <tenant-id> -Audience "api://<client-id>,api://auth-<guid>/<client-id>" -Reconfigure
  ```

**4. Build the agent package.** In the extracted remote zip folder:
```powershell
cd copilot-agent
.\build-agent-package.ps1 -ServerUrl <server-url> -AuthReferenceId <Microsoft Entra SSO registration ID>
```
It creates `esko-webcenter-agent-1.0.0.zip` and saves its settings, including the agent's app ID, in `agent-settings.json`. Keep that file: later rebuilds reuse the same app ID so they update the agent rather than create a second one.

**5. Upload it, for yourself first.** In the **Microsoft 365 admin center** (admin.microsoft.com), go to **Agents → All agents → Upload custom agent** (some tenants label it **Add agent**):
1. Choose the zip and select **Next**.
2. Check the name and icon.
3. Under **Publish**, choose **Just me** (or a small test group).
4. Leave **Deploy** empty for now, then finish.

It can take 5 to 10 minutes to appear.

**6. Test it.** Open the Microsoft 365 Copilot app, or m365.cloud.microsoft/chat:
1. Under **Agents**, pick **WebCenter**.
2. Ask *"Give me the design specs for the project with description crop excellence box."* The first time, select **Sign in to WebCenter** when it asks.
3. You should get AT13294.1B, an RSC 14-1/2 × 9-1/4 × 14-1/2.

To confirm it's free, test once with an engineer's account that has only Copilot Chat. If it answers, and no pay-as-you-go billing is set up for Copilot, it isn't being charged.

**7. Roll it out:**
1. In the admin center, open the agent and change **Publish** to the engineers' group.
2. Optionally use **Deploy** to preinstall it, and pin it so it shows up without searching.
3. Back in the Teams Developer Portal, you can set the SSO registration's **Restrict usage by app** to the app ID printed in step 4.

**Updating the agent later** (instructions, conversation starters): rebuild with a higher version, e.g. `.\build-agent-package.ps1 -Version 1.0.1`, then open the agent in the admin center and upload the new zip as an update. Server updates (step 3) don't need a new agent package: the agent discovers the server's tools each time.

### 4B. Copilot Studio agent (billed per use)

Use this only if you need Copilot Studio features. For Copilot Chat users it's billed in Copilot Credits (see [Billing](#billing-for-copilot-studio-agents)).

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

### Billing for Copilot Studio agents

This applies only to 4B. Your engineers use the free Copilot Chat, without the paid Microsoft 365 Copilot licence. For them, conversations with a Copilot Studio agent are billed in **Copilot Credits**: $0.01 per credit pay-as-you-go, with each tool call counting as an agent action (5 credits). Set this up in the **Microsoft 365 admin center** or the **Power Platform admin center** with one of these:

- **Pay-as-you-go:** link an Azure subscription and set a monthly budget.
- **Prepaid Copilot Credit packs**

Turn on usage alerts so there are no surprises. Users with a paid Microsoft 365 Copilot licence aren't charged for agent use.

## Troubleshooting

| Symptom | Check |
|---|---|
| `<server-url>/healthz` doesn't load | Container Apps: `az containerapp logs show -n esko-webcenter-mcp -g rg-esko-mcp --tail 50`. VM: NSG allows 443 and 80, the DNS label resolves to the VM, and see `C:\EskoMCP\logs\caddy.log` |
| Declarative agent: "Sign in" loops or the tool fails with a 401 | Step 4A.2 done (second URI in `identifierUris`, the `oAuthConsentRedirect` redirect URI, token store client `ab3be6b7-...` authorized), and 4A.3 run with exactly the Application ID URI the Developer Portal showed |
| Declarative agent doesn't appear | Wait 10 minutes; check you're in the agent's **Publish** audience in the admin center, and that custom agents aren't blocked under **Agents → Settings** |
| Declarative agent says it's unavailable / needs billing | It's being treated as metered; tell the developer before turning on any billing. Check the agent has no SharePoint or connector knowledge added |
| Copilot Studio says the connection failed | Callback URL added in Entra (step 4.3); scopes exactly `api://<client-id>/access_as_user offline_access`; admin consent granted |
| "Microsoft sign-in token rejected (ERR_JWT_CLAIM_VALIDATION_FAILED)" in a tool error | `-Audience` matches the Application ID URI; rerun the deploy/install command (VM: add `-Reconfigure`) |
| A user can't sign in | They're assigned to the enterprise app (step 2.6) |
| `WebCenter error 001` | The service account's password changed: rerun the deploy command (VM: `install.ps1 ... -Reconfigure`) |
| `WebCenter error 004` | Too many sessions for the service account; the server uses only one, so check nothing else logs in as `COPILOT_SVC` |
| Container app won't start: "unauthorized" pulling the image | The GitHub token expired or lacks `read:packages`: rerun the deploy command with a new token |
| Anything else | Server logs (see above); ask the agent to run `webcenter_diagnostics_raw_response` with no page for a connection report |

## Later: per-user WebCenter sign-in

Once Esko moves your site to WebCenter **26.07 or later** and enables the **OAuth SSO plugin for SDK authentication**, each engineer can sign in to WebCenter as themselves. They'd then see only what their own account can see, and the service account is no longer needed:

1. **WebCenter:** in the new OAuth admin page, create a client. Add Copilot's callback URL `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` (declarative agent) or Copilot Studio's callback URL as its redirect URL.
2. **The server:** redeploy in OAuth mode, with `.\deploy-containerapp.ps1 -AuthMode oauth -RegistryUsername <github-username>` (Container Apps) or `.\install.ps1 -Hostname <vm-dns-name> -AuthMode oauth -Reconfigure` (VM).
3. **The agent:** for the declarative agent, register an OAuth client in the Teams Developer Portal (**Tools → OAuth client registration**) with WebCenter's client ID, secret and URLs, then rebuild the package with `-AuthReferenceId <that registration ID>`. For Copilot Studio, change the tool's OAuth settings.

The server already supports this mode (`MCP_AUTH_MODE=oauth`), and it's covered by the automated tests.
