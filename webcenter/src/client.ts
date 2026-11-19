// Minimal, read-only client for the Esko WebCenter SDK (JSP calls over HTTP).
// Spec: "WebCenter 26.07 SDK", section 3.1 (general information) and 3.2 (error handling).

import { XMLParser } from "fast-xml-parser";
import { homedir } from "node:os";
import { join } from "node:path";

/** The only SDK pages this server is allowed to call. Anything else is refused before a request is made. */
export const READ_ONLY_PAGES = new Set([
  "GetProjects.jsp",
  "GetDocumentList.jsp",
  "GetDocumentHistory.jsp",
  "GetUserTodoList.jsp",
  "GetUsers.jsp",
  "GetUserInfo.jsp",
  "Search.jsp",
  "GetAttributes.jsp",
  "GetGroupInfo.jsp",
  "GetCharacteristicsTree.jsp",
  "GetProjectsFromCharacteristics.jsp",
  "DocumentGetThumbnailData.jsp",
  "ProjectGetThumbnailData.jsp",
  "DownloadDocument.jsp",
]);

export interface WebCenterConfig {
  baseUrl: string; // e.g. https://abp.esko-saas.com/WebCenter/
  username?: string;
  password?: string; // plain text; encoded to base64 per SDK 3.1
  oauthToken?: string; // alternative to username/password (SDK 3.1)
  ssoiid?: string; // basic-auth SSO instance ID, needed when SAML is the default login (SDK 3.1.5)
  allowLive: boolean;
  timeoutMs: number;
  maxConcurrent: number;
  downloadDir: string;
}

export class WebCenterError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

/** Short explanations for the SDK error codes most likely to come back from read-only calls (SDK section 6). */
const ERROR_HINTS: Record<string, string> = {
  "001": "Login failed. Check the username and password (the password is base64-encoded automatically).",
  "002": "A required parameter was missing.",
  "003": "A parameter had an invalid format or value.",
  "004": "This user already has the maximum of 5 open WebCenter sessions (browser + SDK combined). Close a browser session or wait for one to time out.",
  "005": "The WebCenter user doesn't have the privileges this call needs.",
  "006": "All WebCenter licenses are currently in use.",
  "007": "The WebCenter user's password has expired.",
  "011": "That project doesn't exist or isn't visible to this user.",
  "021": "That document doesn't exist or isn't visible to this user.",
  "031": "That user doesn't exist.",
  "033": "The WebCenter user is not active.",
  "091": "That folder doesn't exist in the project.",
  "008": "WebCenter has no file data for that document version.",
  "014": "One or more projects couldn't be loaded.",
  "043": "No attributes were found on that object.",
  "061": "That characteristic doesn't exist. Check the ID or the \\\\path.",
  "081": "That group doesn't exist.",
  "121": "That task wasn't found or isn't visible to this user.",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebCenterConfig {
  const raw = (env.WEBCENTER_BASE_URL || "").trim();
  if (!raw) throw new WebCenterError("WEBCENTER_BASE_URL is not set. Point it at your WebCenter site, e.g. https://yoursite.esko-saas.com/WebCenter/ (or the local mock: http://127.0.0.1:8765/WebCenter/).");
  const baseUrl = raw.endsWith("/") ? raw : raw + "/";
  return {
    baseUrl,
    username: env.WEBCENTER_USERNAME?.trim() || undefined,
    password: env.WEBCENTER_PASSWORD || undefined,
    oauthToken: env.WEBCENTER_OAUTH_TOKEN?.trim() || undefined,
    ssoiid: env.WEBCENTER_SSOIID?.trim() || undefined,
    allowLive: /^(1|true|yes)$/i.test(env.WEBCENTER_ALLOW_LIVE || ""),
    timeoutMs: Number(env.WEBCENTER_TIMEOUT_MS || 30000),
    maxConcurrent: Math.max(1, Math.min(3, Number(env.WEBCENTER_MAX_CONCURRENT || 2))),
    downloadDir: (env.WEBCENTER_DOWNLOAD_DIR || "").trim() || join(homedir(), "Downloads", "WebCenter"),
  };
}

function isLocalHost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

// Tags that can repeat and should always be arrays, so callers don't have to handle "one item vs many".
const ARRAY_TAGS = new Set([
  "project", "folder", "project_attribute", "project_characteristic", "document", "att", "document_version",
  "stage", "approver", "approval", "user", "group", "project_wctask", "doc_version_pair", "user_todo_view",
  "submitted_approval", "role", "elem", "item", "user_member", "flex_right", "specification_value_view",
  "attribute_category", "dr", "rsv", "rs",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false, // keep IDs like 00002_0000000444 as strings
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** Simple semaphore: every SDK call logs in and out, and WebCenter allows only 5 sessions per user (SDK 3.1.3). */
class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export type Params = Record<string, string | number | boolean | (string | number)[] | undefined | null>;

export class WebCenterClient {
  private limiter: Limiter;
  constructor(public config: WebCenterConfig) {
    this.limiter = new Limiter(config.maxConcurrent);
  }

  /** Absolute URL for a relative WebCenter path (e.g. a viewer link returned by GetDocumentList). */
  absoluteUrl(path: string): string {
    return new URL(path.replace(/^\//, ""), this.config.baseUrl).toString();
  }

  private checkAllowed(page: string) {
    if (!READ_ONLY_PAGES.has(page)) throw new WebCenterError(`Refusing to call ${page}: this server is read-only.`);
    if (!isLocalHost(this.config.baseUrl) && !this.config.allowLive) {
      throw new WebCenterError(
        `Live WebCenter calls are switched off. ${this.config.baseUrl} is not a local mock, and WEBCENTER_ALLOW_LIVE is not set to true. ` +
          `Once Esko has confirmed SDK access, turn on "Allow live WebCenter" in the extension settings (or set WEBCENTER_ALLOW_LIVE=true).`,
      );
    }
    if (!this.config.oauthToken && !(this.config.username && this.config.password)) {
      throw new WebCenterError("No credentials configured. Set WEBCENTER_USERNAME and WEBCENTER_PASSWORD, or WEBCENTER_OAUTH_TOKEN.");
    }
  }

  private buildRequest(params: Params) {
    const body = new URLSearchParams();
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
    if (this.config.oauthToken) {
      headers["Authorization"] = `Bearer ${this.config.oauthToken}`;
    } else {
      body.append("username", this.config.username!);
      body.append("password", Buffer.from(this.config.password!, "utf8").toString("base64"));
      if (this.config.ssoiid) body.append("ssoiid", this.config.ssoiid);
    }
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => body.append(k, String(x)));
      else body.append(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    return { body, headers };
  }

  /** Raw call. Parameters go in a POST body so credentials never appear in URLs or server access logs (SDK FAQ 4.1). */
  async callRaw(page: string, params: Params): Promise<{ contentType: string; text: string }> {
    this.checkAllowed(page);
    const { body, headers } = this.buildRequest(params);

    return this.limiter.run(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
      let res: Response;
      try {
        res = await fetch(new URL(page, this.config.baseUrl), { method: "POST", headers, body, signal: ctrl.signal, redirect: "follow" });
      } catch (e: any) {
        throw new WebCenterError(e?.name === "AbortError" ? `WebCenter did not answer within ${this.config.timeoutMs / 1000}s.` : `Could not reach WebCenter at ${this.config.baseUrl}: ${e?.message || e}`);
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      const contentType = res.headers.get("content-type") || "";
      if (res.status === 404) throw new WebCenterError(`${page} was not found on this WebCenter site (HTTP 404). Check WEBCENTER_BASE_URL.`);
      if (res.status >= 400) throw new WebCenterError(`WebCenter returned HTTP ${res.status} for ${page}.`);
      if (/^\s*(<!doctype html|<html)/i.test(text)) {
        throw new WebCenterError(
          "WebCenter returned a web page instead of SDK data. This usually means single sign-on (SAML) is the default login on your site. " +
            "Set WEBCENTER_SSOIID to the ID of the basic password login on the 'SSO Instance Configuration' admin page (SDK section 3.1.5), or use OAuth.",
        );
      }
      return { contentType, text };
    });
  }

  /** Call an SDK page that returns a file (thumbnail, download). Returns the bytes and the file name WebCenter suggests. */
  async callBinary(page: string, params: Params): Promise<{ data: Buffer; contentType: string; fileName?: string }> {
    this.checkAllowed(page);
    const { body, headers } = this.buildRequest(params);
    return this.limiter.run(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.max(this.config.timeoutMs, 120000));
      let res: Response;
      try {
        res = await fetch(new URL(page, this.config.baseUrl), { method: "POST", headers, body, signal: ctrl.signal, redirect: "follow" });
      } catch (e: any) {
        clearTimeout(timer);
        throw new WebCenterError(e?.name === "AbortError" ? "WebCenter took too long to send the file." : `Could not reach WebCenter at ${this.config.baseUrl}: ${e?.message || e}`);
      }
      try {
        if (res.status === 404) throw new WebCenterError(`${page} was not found on this WebCenter site (HTTP 404).`);
        if (res.status >= 400) throw new WebCenterError(`WebCenter returned HTTP ${res.status} for ${page}.`);
        const data = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") || "";
        // Errors come back as small XML or HTML documents instead of the file.
        if (data.length < 20000 && /xml|html|text/i.test(contentType)) {
          const text = data.toString("utf8");
          if (/<error>/i.test(text)) {
            const doc = parser.parse(text);
            const code = String(doc?.error?.code ?? "000");
            const hint = ERROR_HINTS[code];
            throw new WebCenterError(`WebCenter error ${code}: ${String(doc?.error?.message ?? "Undefined error")}${hint ? ` — ${hint}` : ""}`, code);
          }
          if (/^\s*(<!doctype html|<html)/i.test(text)) throw new WebCenterError("WebCenter returned a web page instead of the file. If your site uses single sign-on, set the SSO instance ID.");
        }
        const cd = res.headers.get("content-disposition") || "";
        const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
        let fileName: string | undefined;
        if (m) {
          try { fileName = decodeURIComponent(m[1]); } catch { fileName = m[1]; }
        }
        return { data, contentType, fileName };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Call an SDK page that returns XML; throws WebCenterError on <error> responses. */
  async call(page: string, params: Params): Promise<any> {
    const { text } = await this.callRaw(page, params);
    let doc: any;
    try {
      doc = parser.parse(text);
    } catch {
      throw new WebCenterError(`Could not read the response from ${page} as XML.`);
    }
    if (doc?.error) {
      const code = String(doc.error.code ?? "000");
      const msg = String(doc.error.message ?? "Undefined error");
      const hint = ERROR_HINTS[code];
      throw new WebCenterError(`WebCenter error ${code}: ${msg}${hint ? ` — ${hint}` : ""}`, code);
    }
    return doc;
  }
}

// ---- small shared helpers for shaping output ---------------------------------
export const arr = <T = any>(v: T | T[] | undefined | null | ""): T[] => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);
export const str = (v: any): string | undefined => (v === undefined || v === null || v === "" ? undefined : typeof v === "object" ? (v["#text"] !== undefined ? String(v["#text"]) : undefined) : String(v));

/** WebCenter mixes epoch-millisecond numbers and "YYYY-MM-DD hh:mm:ss.f" strings. Normalise to ISO; 0 means "not set". */
export function date(v: any): string | undefined {
  const s = str(v);
  if (!s || s === "0" || s === "0.0") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 0 ? new Date(n).toISOString() : undefined;
  }
  return s;
}

/** Drop undefined fields and empty arrays so tool output stays compact. */
export function compact<T>(o: T): T {
  if (Array.isArray(o)) return o.map(compact) as any;
  if (o && typeof o === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(o as any)) {
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return o;
}

/** Tiny time-based cache for lookups that rarely change (users, groups). */
export class TtlCache<V> {
  private map = new Map<string, { v: Promise<V>; at: number }>();
  constructor(private ttlMs: number) {}
  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.map.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v;
    const v = load();
    this.map.set(key, { v, at: Date.now() });
    v.catch(() => this.map.delete(key));
    return v;
  }
}

/** Pick the first non-empty value among candidate tag names (the live site sometimes differs from the SDK document). */
export function pick(o: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(o?.[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
