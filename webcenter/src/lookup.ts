// Resolves user and group IDs to names, with caching.
// Project managers can be users or groups; GetProjects often returns only the ID, so we look them up.

import { WebCenterClient, TtlCache, arr, str } from "./client.js";

export interface Principal {
  id: string;
  kind?: "user" | "group";
  username?: string;
  name?: string;
  email?: string;
}

const TEN_MINUTES = 10 * 60 * 1000;

export class Lookup {
  private users = new TtlCache<Map<string, Principal>>(TEN_MINUTES);
  private groups = new TtlCache<Principal | undefined>(TEN_MINUTES);

  constructor(private wc: WebCenterClient) {}

  /** All users, keyed by ID. One GetUsers call, cached. Returns an empty map if the account lacks the rights. */
  userMap(): Promise<Map<string, Principal>> {
    return this.users.get("all", async () => {
      const doc = await this.wc.call("GetUsers.jsp", { verbose: 1 });
      const map = new Map<string, Principal>();
      for (const u of arr(doc.result?.user_list?.user)) {
        const id = u["@id"];
        if (!id) continue;
        map.set(id, { id, kind: "user", username: str(u.name), name: [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ") || str(u.name), email: str(u.email) });
      }
      return map;
    }).catch(() => new Map());
  }

  /** One group, by ID. Cached. Undefined if it doesn't exist or the account lacks rights. */
  group(id: string): Promise<Principal | undefined> {
    return this.groups.get(id, async () => {
      const doc = await this.wc.call("GetGroupInfo.jsp", { askedgroupid: id });
      const g = arr(doc.group)[0];
      if (!g) return undefined;
      return { id, kind: "group" as const, name: str(g.group_name) };
    }).catch(() => undefined);
  }

  /** Resolve an ID that may be a user or a group. kindHint comes from fields like manager_type. */
  async principal(id: string | undefined, kindHint?: string): Promise<Principal | undefined> {
    if (!id) return undefined;
    if (kindHint !== "group") {
      const u = (await this.userMap()).get(id);
      if (u) return u;
    }
    const g = await this.group(id);
    if (g) return g;
    return { id };
  }

  /** Resolve many IDs at once (deduplicated). */
  async many(entries: { id?: string; kindHint?: string }[]): Promise<Map<string, Principal>> {
    const unique = new Map<string, string | undefined>();
    for (const e of entries) if (e.id && !unique.has(e.id)) unique.set(e.id, e.kindHint);
    const out = new Map<string, Principal>();
    await Promise.all([...unique].map(async ([id, hint]) => {
      const p = await this.principal(id, hint);
      if (p) out.set(id, p);
    }));
    return out;
  }
}
