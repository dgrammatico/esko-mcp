# Esko WebCenter in Microsoft 365 Copilot: setup guide

This puts the read-only WebCenter tools into the Microsoft 365 Copilot app (Copilot Chat) as an agent called **Esko WebCenter**. Agent has to be selected in copilot to utilize the tools.
```
Copilot app ──(user signs in with their Microsoft account)──► WebCenter agent (declarative agent)
                                                                        │  HTTPS + Entra access token
                                                                        ▼
                         server- Azure Container Apps (recommended deployment) or a Win VM
                                                                        │  WebCenter
                                                                        ▼
                                                     https://yourdomain.esko-saas.com/WebCenter/
```

**sign-in:**
- **Copilot:**  The server checks sign-in on every request and accepts only your organization accounts that match with the service account domains or optionally only an assigned group.
- **WebCenter:** Webcenter MUST make calls with one dedicated esko service account for visibility. per user WebCenter sign in for SDK integrations needs v26.07+, See [Later: per-user WebCenter sign-in](#later-per-user-webcenter-sign-in).
- **Audit log:** every tool call is logged on the machine with the person's name. data like args and tokens are obviously never logged.

setup:

1. [WebCenter service account](#1-webcenter-service-account)
2. [Entra app registration](#2-entra-app-registration)
3. [Host the server](#3-host-the-server)
4. [The Copilot agent](#4-the-copilot-agent) 


note- `<server-url>` is the address the hosting step prints, e.g. `https://esko-webcenter-mcp.<region>.azurecontainerapps.io` or `https://yourdomain-webcenter-mcp.eastus.cloudapp.azure.com`.

**Setup steps for copilot are not available right now due to copilot support issues. Will continue to update with time.**
