// Read-only WebCenter tools. Each maps to one SDK call from the WebCenter 26.07 SDK document.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WebCenterClient, WebCenterError, arr, str, date, compact, pick } from "./client.js";
import { Lookup, Principal } from "./lookup.js";

const MAX_OUTPUT_CHARS = 60_000;

export function ok(data: unknown) {
  let text = JSON.stringify(compact(data), null, 1);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + `\n… [output truncated at ${MAX_OUTPUT_CHARS} characters; narrow the request, e.g. with a name filter or a smaller page size]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

export function fail(e: unknown) {
  const msg = e instanceof WebCenterError ? e.message : `Unexpected error: ${(e as Error)?.message || e}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Wrap a plain substring in wildcards, as the WebCenter name filters expect (e.g. "1001" -> "*1001*"). */
export const wild = (s?: string) => (!s ? undefined : s.includes("*") ? s : `*${s}*`);

// ---- output shaping ----------------------------------------------------------
/** Who manages a project. The live site nests <group> or <user> inside <manager>; the SDK document shows user fields directly. */
function shapeManager(p: any) {
  const m = p.manager;
  const type = str(p.manager_type);
  const g = arr(m?.group)[0];
  if (g) return { id: g["@id"] ?? m?.["@id"], kind: str(g.is_role) === "1" ? "role" : "group", name: str(g.name) };
  const u = arr(m?.user)[0] ?? (m && (m.name !== undefined || m.first_name !== undefined) ? m : undefined);
  if (u && type !== "group") {
    return { id: u["@id"] ?? m?.["@id"], kind: "user", username: str(u.name), name: [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ") || str(u.name), email: str(u.email) };
  }
  return { id: str(p.manager_id) ?? m?.["@id"], kind: type };
}

function shapeCreator(p: any) {
  const c = p.projectcreator;
  if (!c) return undefined;
  return { id: c["@id"], username: str(c.name), name: [str(c.first_name), str(c.last_name)].filter(Boolean).join(" ") || undefined };
}

function shapeProject(p: any, detailed: boolean) {
  const base = {
    id: p["@id"],
    name: str(p.name),
    description: str(p.description),
    is_template: str(p.is_template) === "1",
    status: pick(p, "status_name", "project_status_name") ?? str(p.status?.status_name) ?? str(p.status?.name),
    status_id: str(p.status_id) ?? str(p.status?.["@id"]),
    manager: shapeManager(p) as any,
    created_by: shapeCreator(p),
    created: date(p.created_date),
    modified: date(p.modified_date),
    due: date(p.due_date),
  };
  if (!detailed) return base;
  const perm = p.project_user_permission?.permission;
  return {
    ...base,
    folders: arr(p.folder_list?.folder).map((f: any) => ({ id: f["@id"], name: str(f.name), description: str(f.description), document_count: str(f.total_docs) })),
    attributes: arr(p.attribute_list?.project_attribute).map((a: any) => ({ attribute_id: str(a.attribute_id), value: str(a.attribute_value) })),
    characteristics: arr(p.characteristic_list?.project_characteristic).map((c: any) => ({ id: str(c.characteristic_id), name: str(c.characteristic_name) })),
    child_projects: arr(p.child_project_list?.project).map((c: any) => ({ id: c["@id"], name: str(c.name) })),
    parent_projects: arr(p.parent_project_list?.project).map((c: any) => ({ id: c["@id"], name: str(c.name) })),
    your_permissions: perm ? Object.entries(perm).filter(([, v]) => String(v) === "1").map(([k]) => k) : undefined,
  };
}

function shapeUserRef(u: any) {
  if (!u) return undefined;
  return compact({
    id: str(u.userID) ?? u["@id"],
    username: str(u.login) ?? str(u.name),
    name: [str(u.firstname ?? u.first_name), str(u.lastname ?? u.last_name)].filter(Boolean).join(" ") || undefined,
    email: str(u.email),
    company: str(u.companyname),
  });
}

/** Fill in manager names that GetProjects left as bare IDs, and status names WebCenter only gives as IDs. */
async function fillManagers(lookup: Lookup, projects: any[]) {
  await Promise.all([fillManagerNames(lookup, projects), lookup.fillStatusNames(projects)]);
}

async function fillManagerNames(lookup: Lookup, projects: any[]) {
  const missing = projects.map((p) => p.manager).filter((m: any) => m?.id && !m.name);
  if (!missing.length) return;
  const found = await lookup.many(missing.map((m: any) => ({ id: m.id, kindHint: m.kind })));
  for (const p of projects) {
    const m = p.manager;
    if (!m?.id || m.name) continue;
    const f: Principal | undefined = found.get(m.id);
    if (f?.name) p.manager = { ...m, ...f };
  }
}

/** The live site names the version-number field differently from the SDK document, so try the known names. */
function versionOf(d: any): string | undefined {
  const v = pick(d, "document_version", "version", "version_counter", "version_number", "versionnumber", "doc_version", "document_version_number", "version_index");
  if (v !== undefined) return v;
  for (const [k, val] of Object.entries(d ?? {})) {
    if (/version/i.test(k) && !/id$|_id|comment/i.test(k) && /^\d{1,5}$/.test(String(val))) return String(val);
  }
  return undefined;
}

/** An attribute's display value: DateTime epoch-ms becomes an ISO date. */
export function attrValue(t: any): string | undefined {
  const v = str(t?.av);
  if (v === undefined) return undefined;
  if (/date/i.test(str(t?.at) ?? "") && /^\d{11,14}$/.test(v)) return new Date(Number(v)).toISOString().slice(0, 10);
  return v;
}

// ---- tools -----------------------------------------------------------------
export function registerTools(server: McpServer, wc: WebCenterClient, lookup: Lookup) {
  // 1. Find projects (SDK 3.5 GetProjects.jsp)
  server.registerTool(
    "webcenter_find_projects",
    {
      title: "Find WebCenter projects",
      description:
        "List WebCenter projects or templates. Use scope to pick which projects: 'member' (projects the user is in), 'managed' (projects the user manages), " +
        "'favorites', 'templates', or 'all_by_name' (every project visible to the user whose name matches name_contains; name_contains is required for this scope). " +
        "Returns IDs you can pass to the other tools. Status is returned as a status ID; filter by status name with the status parameter.",
      inputSchema: {
        scope: z.enum(["member", "managed", "favorites", "templates", "all_by_name"]).default("member"),
        name_contains: z.string().optional().describe("Text the project name must contain. Supports * wildcards, e.g. 'ACME*carton'."),
        status: z.string().optional().describe("Project status name, e.g. 'Active'."),
        modified_within_days: z.number().int().positive().optional(),
        sort: z.enum(["name", "name_desc", "created_newest", "modified_newest", "status", "manager"]).default("modified_newest"),
        page: z.number().int().positive().default(1),
        page_size: z.number().int().min(1).max(500).default(50),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const typeMap = { favorites: 1, member: 2, managed: 3, templates: 5, all_by_name: 6 } as const;
        const sortMap = { name: 1, name_desc: 2, status: 5, manager: 7, created_newest: 10, modified_newest: 12 } as const;
        if (a.scope === "all_by_name" && !a.name_contains) throw new WebCenterError("name_contains is required when scope is 'all_by_name'.");
        const doc = await wc.call("GetProjects.jsp", {
          type: typeMap[a.scope],
          name: wild(a.name_contains),
          gettemplates: a.scope === "all_by_name" ? 0 : undefined,
          statusname: a.status,
          numdays: a.modified_within_days,
          sorting: sortMap[a.sort],
          curpage: a.page,
          pagesize: a.page_size,
          showthumbnails: 0,
        });
        const r = doc.get_project_list ?? {};
        const projects = arr(r.project_list?.project).map((p: any) => shapeProject(p, false));
        await fillManagers(lookup, projects);
        return ok({ total_matching: str(r.total_filter_projects), page: a.page, page_size: a.page_size, returned: projects.length, projects });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 2. Project details (SDK 3.5 GetProjects.jsp, type=6, details=1)
  server.registerTool(
    "webcenter_get_project",
    {
      title: "Get WebCenter project details",
      description: "Get one project's details: manager, dates, folders (with IDs and document counts), attributes, characteristics, parent/child projects, and your permissions on it. Give project_id or the exact project_name.",
      inputSchema: {
        project_id: z.string().optional().describe("Project ID, e.g. 00002_0000000135"),
        project_name: z.string().optional().describe("Exact project name (used if project_id is not given)."),
        is_template: z.boolean().default(false).describe("Set true when looking up a template by name."),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.project_id && !a.project_name) throw new WebCenterError("Give project_id or project_name.");
        const doc = await wc.call("GetProjects.jsp", {
          type: 6,
          projectid: a.project_id,
          name: a.project_id ? undefined : a.project_name,
          gettemplates: a.project_id ? undefined : a.is_template ? 1 : 0,
          details: 1,
          showthumbnails: 0,
        });
        const list = arr(doc.get_project_list?.project_list?.project);
        if (!list.length) throw new WebCenterError("No project found with that ID or name, or it isn't visible to this user.");
        const project: any = shapeProject(list[0], true);
        await fillManagers(lookup, [project]);
        // GetProjects only gives attribute IDs; GetAttributes gives names. Show named, non-empty values.
        try {
          const attrs = await wc.call("GetAttributes.jsp", { projectid: project.id, categorydetails: 1 });
          const root = attrs[Object.keys(attrs).find((k) => k !== "?xml") ?? ""] ?? attrs;
          const named = arr(root?.attribute_category ?? attrs.attribute_category).flatMap((c: any) => arr(c.atts?.att))
            .map((t: any) => ({ name: str(t.an), value: attrValue(t) }))
            .filter((x: any) => x.value !== undefined);
          if (named.length) project.attributes = named;
        } catch {
          /* keep the ID-only attributes */
        }
        return ok({ project, other_matches: list.slice(1).map((p: any) => ({ id: p["@id"], name: str(p.name) })) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 3. Documents in a project (SDK 3.8 GetDocumentList.jsp)
  server.registerTool(
    "webcenter_list_documents",
    {
      title: "List documents in a WebCenter project",
      description:
        "List the documents in a project (all folders by default), with the latest version number, author, size, approval status and a link that opens the document in the WebCenter viewer. " +
        "Includes ArtiosCAD designs (.ARD). Optionally limit to folders and include document attributes.",
      inputSchema: {
        project_id: z.string().optional(),
        project_name: z.string().optional(),
        folder_ids: z.array(z.string()).optional().describe("Only these folder IDs. Use an empty string for the project's root folder."),
        folder_names: z.array(z.string()).optional(),
        name_contains: z.string().optional().describe("Filter the returned documents by name (case-insensitive, applied after loading)."),
        include_attributes: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.project_id && !a.project_name) throw new WebCenterError("Give project_id or project_name.");
        const doc = await wc.call("GetDocumentList.jsp", {
          projectid: a.project_id,
          projectname: a.project_id ? undefined : a.project_name,
          folderid: a.folder_ids,
          foldername: a.folder_names,
          attributeinfo: a.include_attributes ? 1 : 0,
        });
        const list = doc.document_list ?? {};
        let docs = arr(list.document).map((d: any) => ({
          document_id: str(d.document_id),
          version_id: str(d.document_version_id),
          name: str(d.document_name),
          folder: str(d.folder_name) ?? (str(d.folder_id) ? undefined : "(root)"),
          folder_id: str(d.folder_id),
          version: versionOf(d),
          description: str(d.document_description),
          version_comments: str(d.version_comments),
          size_bytes: str(d.file_size),
          created: date(d.creation_date),
          author: d.author ? { id: d.author["@id"], name: [str(d.author.first_name), str(d.author.last_name)].filter(Boolean).join(" ") } : undefined,
          approval: str(d.approval_cycle_info),
          viewer_url: str(d.viewable) === "true" && str(d.get_viewer) ? wc.absoluteUrl(str(d.get_viewer)!) : undefined,
          attributes: a.include_attributes
            ? arr(d.attribute_category).flatMap((c: any) => arr(c.atts?.att).map((t: any) => ({ category: str(c.name), name: str(t.an), value: str(t.av), type: str(t.at) })))
            : undefined,
        }));
        if (a.name_contains) docs = docs.filter((d) => d.name?.toLowerCase().includes(a.name_contains!.toLowerCase()));
        return ok({ project_id: list["@projectid"], document_count: docs.length, documents: docs });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 4. Document history and approvals (SDK 3.11 GetDocumentHistory.jsp)
  server.registerTool(
    "webcenter_get_document_history",
    {
      title: "Get document versions and approval history",
      description:
        "Get every version of a document with who uploaded it and when, its approval status per version, approval stages and approvers' decisions and comments, and who still needs to approve the current version. " +
        "Identify the document by document_id (from webcenter_list_documents), or by project plus document_name.",
      inputSchema: {
        document_id: z.string().optional().describe("Document ID or document version ID."),
        project_id: z.string().optional(),
        project_name: z.string().optional(),
        document_name: z.string().optional(),
        include_approval_details: z.boolean().default(true),
        include_annotations: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.document_id && !(a.document_name && (a.project_id || a.project_name))) throw new WebCenterError("Give document_id, or document_name with project_id or project_name.");
        const doc = await wc.call("GetDocumentHistory.jsp", {
          documentid: a.document_id,
          projectid: a.document_id ? undefined : a.project_id,
          projectname: a.document_id || a.project_id ? undefined : a.project_name,
          documentname: a.document_id ? undefined : a.document_name,
          approvalinfo: a.include_approval_details ? 1 : 0,
          annotationinfo: a.include_annotations ? 1 : 0,
          fulluserinfo: 1,
        });
        const info = doc.document_info ?? {};
        const versions = arr(info.document_version).map((v: any) => ({
          version: str(v.version_number),
          version_id: str(v.docVersionID),
          created: date(v.creation_date),
          comments: str(v.version_comments),
          author: shapeUserRef(arr(v.author?.user)[0]),
          approval_status: str(v.document_approval_status),
          approval_cycle: str(v.document_approval_cycle_status),
          current_stage: str(v.stage_index),
          stages: arr(v.stages?.stage).map((s: any) => ({
            name: str(s.name),
            index: str(s.index),
            status: str(s.stage_approval_status),
            approvers: arr(s.approver_list?.approver).map((ap: any) => ({
              approver: shapeUserRef(arr(ap.user)[0]) ?? { group_id: str(ap.groupID) },
              decision: str(ap.approval_action?.approval_status),
              date: date(ap.approval_action?.approval_date),
              comment: str(ap.approval_action?.approval_comment),
              forwarded: str(ap.is_forwarded_approver) === "1" || undefined,
            })),
          })),
          annotation_count: a.include_annotations ? arr(v.annotations?.annotation).length : undefined,
        }));
        return ok({
          document_id: str(info.docID),
          name: str(info.document_name),
          description: str(info.description),
          modified: date(info.modification_date),
          waiting_on_approvers: arr(info.approval_users?.user).map(shapeUserRef),
          versions,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 5. To-do list (SDK 3.31 GetUserTodoList.jsp)
  server.registerTool(
    "webcenter_get_todo_list",
    {
      title: "Get a WebCenter to-do list",
      description:
        "Get the tasks and document approvals waiting on a user (the logged-in user by default). Optionally include recently completed tasks and submitted approvals. " +
        "Looking up another user's list (for_username) needs admin rights.",
      inputSchema: {
        for_username: z.string().optional().describe("Another user's WebCenter username (admins only)."),
        include_tasks: z.boolean().default(true),
        include_approvals: z.boolean().default(true),
        include_recent: z.boolean().default(false).describe("Also show recently completed tasks and submitted approvals."),
        history_days: z.number().int().positive().max(365).default(5),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const doc = await wc.call("GetUserTodoList.jsp", {
          askedusername: a.for_username,
          showtasks: a.include_tasks ? 1 : 0,
          showapprovals: a.include_approvals ? 1 : 0,
          showrecenttasks: a.include_recent ? 1 : 0,
          showrecentapprovals: a.include_recent ? 1 : 0,
          historylength: a.history_days,
        });
        const t = doc.todo_list ?? {};
        const task = (x: any) => ({
          task_id: x["@id"],
          name: str(x.name),
          description: str(x.description),
          type: str(x.task_type_name),
          status: str(x.status?.status_name),
          project: { id: str(x.project_id), name: str(x.project_name) },
          created: date(x.created_date),
          due: date(x.due_date),
          documents: arr(x.doc_version_list?.doc_version_pair).map((d: any) => ({ version_id: d["@id"], name: str(d.doc_name) })),
        });
        return ok({
          user: arr(t.user)[0] ? { id: arr(t.user)[0]["@id"], username: str(arr(t.user)[0].name), name: [str(arr(t.user)[0].first_name), str(arr(t.user)[0].last_name)].filter(Boolean).join(" ") } : undefined,
          tasks_to_do: arr(t.project_wc_task_list?.project_wctask).map(task),
          approvals_to_do: arr(t.document_approval_list?.user_todo_view).map((d: any) => ({
            document: str(d.doc_name),
            document_id: str(d.doc_id),
            version_id: str(d.doc_version_id),
            version: str(d.version_counter),
            uploaded_by: str(d.version_author_name),
            project: { id: str(d.project_id), name: str(d.project_name) },
            due: str(d.has_approval_due_date) === "1" ? date(d.duedate) : undefined,
          })),
          recently_completed_tasks: a.include_recent ? arr(t.done_project_wc_task_list?.project_wctask).map(task) : undefined,
          recently_submitted_approvals: a.include_recent
            ? arr(t.submitted_document_approval_list?.submitted_approval).map((s: any) => ({ version_id: str(s.userapproval?.docVersionid), date: date(s.userapproval?.modified_date), comment: str(s.userapproval?.approvalcomment) }))
            : undefined,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 6. Find users (SDK 3.33 GetUsers.jsp)
  server.registerTool(
    "webcenter_find_users",
    {
      title: "Find WebCenter users",
      description: "List WebCenter users, optionally limited to certain user types and filtered by name. Needs admin, project manager or project creator rights.",
      inputSchema: {
        types: z.array(z.enum(["normal_users", "project_managers", "project_creators", "administrators"])).optional().describe("Omit for all users."),
        name_contains: z.string().optional().describe("Filter by username, first or last name (case-insensitive)."),
        include_details: z.boolean().default(false).describe("Include email and other details."),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const t = new Set(a.types ?? []);
        const doc = await wc.call("GetUsers.jsp", {
          normalusers: a.types ? (t.has("normal_users") ? 1 : 0) : undefined,
          projectmanagers: a.types ? (t.has("project_managers") ? 1 : 0) : undefined,
          projectcreators: a.types ? (t.has("project_creators") ? 1 : 0) : undefined,
          administrators: a.types ? (t.has("administrators") ? 1 : 0) : undefined,
          verbose: a.include_details ? 1 : 0,
        });
        let users = arr(doc.result?.user_list?.user).map((u: any) => ({
          id: u["@id"],
          username: str(u.name),
          name: [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ") || undefined,
          email: str(u.email),
          is_project_manager: a.include_details ? str(u.is_project_manager) === "1" : undefined,
        }));
        if (a.name_contains) {
          const n = a.name_contains.toLowerCase();
          users = users.filter((u) => [u.username, u.name].some((x) => x?.toLowerCase().includes(n)));
        }
        return ok({ total: users.length, returned: Math.min(users.length, a.limit), users: users.slice(0, a.limit) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 7. User details (SDK 3.48 GetUserInfo.jsp)
  server.registerTool(
    "webcenter_get_user",
    {
      title: "Get a WebCenter user's details",
      description: "Get one user's details: name, company and location, email, role (admin / project manager / project creator), active status and groups. Needs admin rights.",
      inputSchema: {
        username: z.string().optional(),
        user_id: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.username && !a.user_id) throw new WebCenterError("Give username or user_id.");
        const doc = await wc.call("GetUserInfo.jsp", { askeduserid: a.user_id, askedusername: a.user_id ? undefined : a.username });
        const u = arr(doc.user)[0];
        if (!u) throw new WebCenterError("No user returned.");
        const isAdmin = str(u.is_admin) === "1" || u.admin_rights !== undefined;
        return ok({
          id: str(u.user_id),
          username: str(u.username),
          name: [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ") || undefined,
          email: str(u["e-mail"]),
          company: str(u.company),
          location: str(u.company_location),
          role: isAdmin ? "administrator" : str(u.project_manager) === "1" ? "project manager" : str(u.project_creator) === "1" ? "project creator" : "normal user",
          active: str(u.is_active) === "1",
          ldap_user: str(u.ldap_user) === "1",
          groups: arr(u.groups?.group).map((g: any) => ({ id: str(g.group_id), name: str(g.group_name) })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 8. Search (SDK 3.64 Search.jsp) — output format is only documented live on the server.
  server.registerTool(
    "webcenter_search",
    {
      title: "Search WebCenter",
      description:
        "Run a WebCenter saved search by name, or a new search of one type (projects, all documents, tasks, ArtiosCAD designs, graphics, and so on), returning JSON results (top 200 by default). " +
        "Results come from WebCenter's search index, which can lag behind recent changes, so confirm anything important with the other tools. " +
        "Filters use WebCenter's search field names, e.g. {\"filter(proj.name).query\": \"ACME*\"}.",
      inputSchema: {
        saved_search: z.string().optional().describe("Name of a saved search in WebCenter."),
        new_search: z
          .enum(["proj", "alldoc", "wctask", "generic", "des", "mfg", "3d", "graphic", "graphicimage", "pagelist", "collada", "text", "component"])
          .optional()
          .describe("Search type when not using a saved search. des = ArtiosCAD designs, mfg = ArtiosCAD manufacturing, 3d = ArtiosCAD 3D."),
        columns: z.array(z.string()).optional().describe("Result columns, e.g. ['proj.name','proj.status','proj.datedue']."),
        sort: z.string().optional().describe("e.g. 'asc:proj.name'"),
        filters: z.record(z.string()).optional().describe("Extra search parameters, passed through as-is."),
        all_results: z.boolean().default(false).describe("Return every result instead of the top 200."),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.saved_search && !a.new_search) throw new WebCenterError("Give saved_search or new_search.");
        const { text } = await wc.callRaw("Search.jsp", {
          v: 1,
          format: "json",
          savedsearch: a.saved_search,
          newsearch: a.saved_search ? undefined : a.new_search,
          columns: a.columns?.join(","),
          sort: a.sort,
          endindex: a.all_results ? "allresults" : undefined,
          ...(a.filters ?? {}),
        });
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          if (/<error>/.test(text)) {
            const code = text.match(/<code>(.*?)<\/code>/)?.[1];
            const msg = text.match(/<message>(.*?)<\/message>/)?.[1];
            throw new WebCenterError(`WebCenter error ${code ?? "000"}: ${msg ?? "Undefined error"}`, code);
          }
          throw new WebCenterError("Search did not return JSON. Check the saved search name and filter syntax.");
        }
        const d: any = data;
        const table = d?.results?.table;
        if (table?.rows) {
          const fields = new Map<string, string>(arr(d?.meta?.fields).map((f: any) => [f.id, f.label ?? f.id]));
          const rows = arr(table.rows).map((r: any) => {
            const row: Record<string, string | undefined> = { id: r.id };
            for (const c of arr(r.cells)) {
              const vals = arr(c.values).map((v: any) => v.displaytxt ?? v.value).filter((x: any) => x !== undefined && x !== "");
              row[fields.get(c.id) ?? c.id] = vals.join(", ") || undefined;
            }
            return row;
          });
          return ok({ note: "Results come from the search index and may lag behind recent changes. For document searches, id is the document version ID.", total: d?.stats?.total, returned: d?.stats?.returned, rows });
        }
        return ok({ note: "Results come from the search index and may lag behind recent changes.", results: data });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
