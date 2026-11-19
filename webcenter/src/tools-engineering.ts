// Read-only tools aimed at packaging engineers: specs/attributes, thumbnails, downloading designs,
// groups, characteristics, and a diagnostic raw view.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { WebCenterClient, WebCenterError, READ_ONLY_PAGES, arr, str, date } from "./client.js";
import { Lookup } from "./lookup.js";
import { ok, fail, READ_ONLY, attrValue } from "./tools.js";

// ---- helpers -----------------------------------------------------------------

/** Flatten an <attribute_category> block into readable rows (SDK 3.44). */
function shapeAttributes(categories: any[], includeEmpty: boolean) {
  return categories.map((c: any) => {
    const all = arr(c.atts?.att);
    const atts = all.filter((a: any) => includeEmpty || str(a.av) !== undefined);
    return {
    category: str(c.name),
    category_id: str(c.id),
    hidden_empty_attributes: includeEmpty ? undefined : all.length - atts.length || undefined,
    attributes: atts.map((a: any) => ({
      name: str(a.an),
      label: (() => { const l = str(a.alt); return l && !l.startsWith("i18n!") && l !== str(a.an) ? l : undefined; })(),
      value: attrValue(a),
      unit: str(a.au),
      type: str(a.at),
      referenced_documents: arr(a.drs?.dr).map((d: any) => ({
        name: str(d.dn),
        version: str(d.dvidx),
        version_id: str(d.dv),
        approval: str(d.astat),
        count: str(d.count),
      })),
    })),
    };
  });
}

/** Latest version ID of a document, via its history. */
async function latestVersionId(wc: WebCenterClient, documentId: string): Promise<string> {
  const doc = await wc.call("GetDocumentHistory.jsp", { documentid: documentId });
  const versions = arr(doc.document_info?.document_version);
  const last = versions[versions.length - 1];
  const id = str(last?.docVersionID);
  if (!id) throw new WebCenterError("Couldn't find the latest version of that document.");
  return id;
}

function imageMime(buf: Buffer, fallback: string): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  return /^image\//.test(fallback) ? fallback.split(";")[0] : "image/jpeg";
}

function safeFileName(name: string): string {
  const cleaned = basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "WebCenterDownload";
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new WebCenterError("Couldn't find a free file name in the download folder.");
}

function shapeCharTree(elems: any[]): any[] {
  return elems.map((e: any) => ({ name: str(e.name)?.trim(), id: str(e.id), children: shapeCharTree(arr(e.children?.elem)) }));
}

// ---- tools -----------------------------------------------------------------

export function registerEngineeringTools(server: McpServer, wc: WebCenterClient, _lookup: Lookup) {
  // 9. Attributes / specifications (SDK 3.44 GetAttributes.jsp)
  server.registerTool(
    "webcenter_get_attributes",
    {
      title: "Get attributes or specifications",
      description:
        "Get the attribute values (specs) on a project, a document, or a task: e.g. customer, board grade, flute, style, dimensions, part numbers. " +
        "Give a project; add document_id/document_name for the document's attributes, or task_id/task_name for a task's specifications. " +
        "Document-reference attributes list the referenced designs with their version and approval status.",
      inputSchema: {
        project_id: z.string().optional(),
        project_name: z.string().optional(),
        document_id: z.string().optional(),
        document_name: z.string().optional(),
        task_id: z.string().optional(),
        task_name: z.string().optional(),
        reference_levels: z.number().int().min(0).max(3).default(0).describe("Also include attributes of referenced documents, this many levels deep."),
        include_empty: z.boolean().default(false).describe("Also list attributes that have no value (hidden by default)."),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.project_id && !a.project_name) throw new WebCenterError("Give project_id or project_name (the project the object is in).");
        const doc = await wc.call("GetAttributes.jsp", {
          projectid: a.project_id,
          projectname: a.project_id ? undefined : a.project_name,
          documentid: a.document_id,
          documentname: a.document_id ? undefined : a.document_name,
          taskid: a.task_id,
          taskname: a.task_id ? undefined : a.task_name,
          categorydetails: 1,
          getdocrefattributes: a.reference_levels,
        });
        // The root element varies; find every attribute_category anywhere near the top.
        const root = doc[Object.keys(doc).find((k) => k !== "?xml") ?? ""] ?? doc;
        const cats = arr(root?.attribute_category ?? doc.attribute_category);
        const level = a.document_id || a.document_name ? "document" : a.task_id || a.task_name ? "task" : "project";
        return ok({ level, categories: shapeAttributes(cats, a.include_empty) });
      } catch (e: any) {
        if (e instanceof WebCenterError && e.code === "043") return ok({ categories: [], note: "No attributes are set on this object." });
        return fail(e);
      }
    },
  );

  // 12. Thumbnails (SDK 3.9 / 3.10)
  server.registerTool(
    "webcenter_get_thumbnail",
    {
      title: "Show a document or project thumbnail",
      description: "Get the thumbnail image of a document (e.g. a quick look at an ArtiosCAD design) or a project, shown inline. Give document_id or version_id, or a project.",
      inputSchema: {
        document_id: z.string().optional(),
        version_id: z.string().optional(),
        page_index: z.number().int().min(0).optional().describe("For multi-page documents."),
        project_id: z.string().optional().describe("Get the project's thumbnail instead."),
        project_name: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        let res;
        if (a.document_id || a.version_id) {
          res = await wc.callBinary("DocumentGetThumbnailData.jsp", { docid: a.document_id, docverid: a.document_id ? undefined : a.version_id, pageindex: a.page_index });
        } else if (a.project_id || a.project_name) {
          res = await wc.callBinary("ProjectGetThumbnailData.jsp", { projectid: a.project_id, projectname: a.project_id ? undefined : a.project_name });
        } else throw new WebCenterError("Give document_id, version_id, project_id or project_name.");
        if (!res.data.length) throw new WebCenterError("WebCenter returned an empty thumbnail.");
        return { content: [{ type: "image" as const, data: res.data.toString("base64"), mimeType: imageMime(res.data, res.contentType) }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 13. Download a document to this computer (SDK 3.16 DownloadDocument.jsp)
  server.registerTool(
    "webcenter_download_document",
    {
      title: "Download a document to this computer",
      description:
        "Download a document (e.g. an ArtiosCAD .ARD so it can be opened in ArtiosCAD) from WebCenter into the local download folder, and return where it was saved. " +
        "This only reads from WebCenter; nothing in WebCenter changes. Gets the latest version unless version_id is given. Never overwrites an existing file.",
      inputSchema: {
        version_id: z.string().optional().describe("A specific version (from list_documents or document_history)."),
        document_id: z.string().optional().describe("Downloads the latest version."),
        project_id: z.string().optional(),
        project_name: z.string().optional(),
        document_name: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        let versionId = a.version_id;
        if (!versionId && a.document_id) versionId = await latestVersionId(wc, a.document_id);
        if (!versionId && !(a.document_name && (a.project_id || a.project_name))) throw new WebCenterError("Give version_id, document_id, or document_name with a project.");
        const res = await wc.callBinary("DownloadDocument.jsp", {
          docversionid: versionId,
          projectid: versionId ? undefined : a.project_id,
          projectname: versionId || a.project_id ? undefined : a.project_name,
          documentname: versionId ? undefined : a.document_name,
          directdownload: 1,
        });
        if (!res.data.length) throw new WebCenterError("WebCenter returned an empty file.");
        const dir = wc.config.downloadDir;
        await mkdir(dir, { recursive: true });
        const name = safeFileName(res.fileName || a.document_name || `${versionId}.bin`);
        const path = await uniquePath(dir, name);
        await writeFile(path, res.data);
        return ok({ saved_to: path, file_name: basename(path), size_bytes: res.data.length, folder: dir });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 14. Group details (SDK 3.49 GetGroupInfo.jsp)
  server.registerTool(
    "webcenter_get_group",
    {
      title: "Get a WebCenter group and its members",
      description: "Get a group's members (and admin rights). Useful because many projects are managed by a group rather than a person. Needs admin or group-admin rights.",
      inputSchema: { group_id: z.string().optional(), group_name: z.string().optional() },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.group_id && !a.group_name) throw new WebCenterError("Give group_id or group_name.");
        const doc = await wc.call("GetGroupInfo.jsp", { askedgroupid: a.group_id, askedgroupname: a.group_id ? undefined : a.group_name });
        const g = arr(doc.group)[0] ?? {};
        const members = arr(g.user_members?.user_member).map((u: any) => ({
          id: str(u.id),
          username: str(u.username),
          name: [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ") || undefined,
        }));
        return ok({ id: str(g.group_id), name: str(g.group_name), member_count: members.length, admin_rights: arr(g.admin_rights?.flex_right).map(String), members });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 15. Characteristics tree (SDK 3.50)
  server.registerTool(
    "webcenter_browse_characteristics",
    {
      title: "Browse WebCenter characteristics",
      description: "Show the characteristics tree (the classification used to tag projects, e.g. customer / product type / plant), or one branch of it. Paths use double backslashes: \\\\Customer\\\\Automotive.",
      inputSchema: {
        root_id: z.string().optional(),
        root_path: z.string().optional().describe("e.g. \\\\Customer"),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const doc = await wc.call("GetCharacteristicsTree.jsp", { rootcharid: a.root_id, rootcharpath: a.root_id ? undefined : a.root_path });
        return ok({ tree: shapeCharTree(arr(doc.char_tree?.elem)) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 16. Projects by characteristic (SDK 3.51)
  server.registerTool(
    "webcenter_find_projects_by_characteristic",
    {
      title: "Find projects tagged with a characteristic",
      description: "List the projects tagged with a characteristic (optionally including its sub-characteristics). Get IDs/paths from webcenter_browse_characteristics. Needs admin rights.",
      inputSchema: {
        characteristic_id: z.string().optional(),
        characteristic_path: z.string().optional(),
        include_subtree: z.boolean().default(false),
        limit: z.number().int().min(1).max(2000).default(200),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.characteristic_id && !a.characteristic_path) throw new WebCenterError("Give characteristic_id or characteristic_path.");
        const doc = await wc.call("GetProjectsFromCharacteristics.jsp", {
          characteristicid: a.characteristic_id,
          characteristicpath: a.characteristic_id ? undefined : a.characteristic_path,
          includesubtree: a.include_subtree ? 1 : 0,
        });
        const all = arr(doc.project_list?.project).map((p: any) => ({
          id: p["@id"],
          name: str(p.name),
          description: str(p.description),
          is_template: str(p.is_template) === "1",
          created: date(p.created_date),
          modified: date(p.modified_date),
        }));
        return ok({ total: all.length, returned: Math.min(all.length, a.limit), projects: all.slice(0, a.limit) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 17. Diagnostics: raw response of an allowlisted read-only call
  server.registerTool(
    "webcenter_diagnostics_raw_response",
    {
      title: "Diagnostics: raw WebCenter response",
      description:
        "Troubleshooting only: return the raw XML/JSON WebCenter sends for one of this server's read-only SDK calls, so field names can be checked against what the tools show. " +
        "Only the read-only pages this server already uses are allowed. Prefer the regular tools for normal questions.",
      inputSchema: {
        page: z.string().describe("e.g. GetDocumentList.jsp"),
        params: z.record(z.string()).default({}).describe("SDK parameters (credentials are added automatically)."),
        max_chars: z.number().int().min(500).max(60000).default(15000),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!READ_ONLY_PAGES.has(a.page)) throw new WebCenterError(`Not allowed: ${a.page}. Allowed pages: ${[...READ_ONLY_PAGES].join(", ")}`);
        if (/Thumbnail|Download/i.test(a.page)) throw new WebCenterError("Binary pages can't be shown raw. Use webcenter_get_thumbnail or webcenter_download_document.");
        const lower = Object.fromEntries(Object.entries(a.params).filter(([k]) => !/^(username|password|ssoiid)$/i.test(k)));
        const { text, contentType } = await wc.callRaw(a.page, lower);
        const cut = text.length > a.max_chars;
        return { content: [{ type: "text" as const, text: `Content-Type: ${contentType}\nLength: ${text.length} chars${cut ? ` (showing first ${a.max_chars})` : ""}\n\n${cut ? text.slice(0, a.max_chars) : text}` }] };
      } catch (e) {
        return fail(e);
      }
    },
  );
}

