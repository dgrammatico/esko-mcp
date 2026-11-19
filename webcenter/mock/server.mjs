// Mock Esko WebCenter SDK server for local development.
// Returns XML shaped like the examples in the WebCenter 26.07 SDK document,
// so the MCP server can be built and tested without touching a real WebCenter site.
//
// Usage: node mock/server.mjs [port]     (default port 8765)
// Mock login: username MOCKUSER, password "mockpass" (sent base64-encoded as the SDK requires)
// Special username SSOUSER returns an HTML login page, to simulate SAML being the default login.

import http from "node:http";

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8765);
const BASE_PATH = "/WebCenter/";
const MOCK_USER = "MOCKUSER";
const MOCK_PASS_B64 = Buffer.from("mockpass", "utf8").toString("base64");

// ---- sample data -----------------------------------------------------------
const users = [
  { id: "00002_0000000444", name: "MOCKUSER", first: "Mock", last: "User", email: "mock.user@example.com", company: "EXAMPLE PACKAGING", location: "Main Plant", admin: true, pm: true },
  { id: "00002_0000000501", name: "JSMITH", first: "Jane", last: "Smith", email: "jane.smith@example.com", company: "EXAMPLE PACKAGING", location: "Main Plant", admin: false, pm: true },
  { id: "00002_0000000502", name: "BRAND1", first: "Bob", last: "Brand", email: "bob@brandco.example", company: "BRANDCO", location: "HQ", admin: false, pm: false },
];

const projects = [
  { id: "00002_0000001001", name: "ACME-1001 Cereal Carton", description: "Folding carton, 3 SKUs", status: "Active", statusId: "00001_0000000001", managerId: users[0].id, created: 1762000000000, modified: 1763300000000, due: 1764500000000,
    folders: [{ id: "00002_0000002001", name: "Structural" }, { id: "00002_0000002002", name: "Graphics" }],
    attributes: [{ id: "00002_0000000002", value: "ACME Foods" }, { id: "00002_0000000018", value: "SBS 18pt" }] },
  { id: "00002_0000001002", name: "ACME-1002 Shipper RSC", description: "Corrugated shipper", status: "Active", statusId: "00001_0000000001", managerId: "00002_0000000002", managerType: "group", created: 1761000000000, modified: 1763000000000, due: 0, folders: [], attributes: [] },
  { id: "00002_0000001003", name: "BRANDCO-77 Display", description: "POP display", status: "Completed", statusId: "00001_0000000003", managerId: users[0].id, created: 1755000000000, modified: 1758000000000, due: 0, folders: [], attributes: [] },
  { id: "00002_0000001900", name: "TEMPLATE Folding Carton", description: "Standard carton template", status: "Active", statusId: "00001_0000000001", managerId: users[0].id, created: 1700000000000, modified: 1700000000000, due: 0, folders: [], attributes: [], template: true },
];

const documents = [
  { projectId: "00002_0000001001", docId: "00002_0000003001", verId: "00002_0000004003", folderId: "00002_0000002001", folderName: "Structural", name: "1001-carton.ARD", version: 3, description: "Structural design", comments: "Glue flap widened", size: 48120, created: "2026-11-10 14:02:11.12", authorId: users[1].id, approval: "Pending", viewable: true },
  { projectId: "00002_0000001001", docId: "00002_0000003002", verId: "00002_0000004010", folderId: "00002_0000002002", folderName: "Graphics", name: "1001-artwork.pdf", version: 2, description: "Front panel artwork", comments: "Updated nutrition panel", size: 9312004, created: "2026-11-12 09:15:40.50", authorId: users[0].id, approval: "Approved", viewable: true },
  { projectId: "00002_0000001002", docId: "00002_0000003101", verId: "00002_0000004101", folderId: "", folderName: "", name: "shipper-rsc.ARD", version: 1, description: "RSC 300x200x150", comments: "", size: 22011, created: "2026-11-05 11:00:00.00", authorId: users[1].id, approval: "approval is not required on this document", viewable: true },
];

// ---- helpers ----------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const err = (code, message) => `<error><code>${code}</code><message>${esc(message)}</message></error>`;
const userById = (id) => users.find((u) => u.id === id);

function parseParams(req, body) {
  const url = new URL(req.url, "http://localhost");
  const params = new URLSearchParams(url.search);
  const ct = req.headers["content-type"] || "";
  if (body && ct.includes("application/x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(body)) params.append(k, v);
  }
  // SDK parameter names are case-insensitive
  const lower = new Map();
  for (const [k, v] of params) {
    const key = k.toLowerCase();
    if (!lower.has(key)) lower.set(key, []);
    lower.get(key).push(v);
  }
  return { page: url.pathname, get: (k) => lower.get(k)?.[0], all: (k) => lower.get(k) || [] };
}

const groups = [{ id: "00002_0000000002", name: "US ENGINEERS", members: [users[0], users[1]] }];

function projectXml(p, details) {
  const m = p.managerType === "group" ? null : userById(p.managerId);
  const folders = details ? p.folders.map((f) => `<folder id="${f.id}"><deleted>0</deleted><name>${esc(f.name)}</name><description/><total_docs>${documents.filter((d) => d.folderId === f.id).length}</total_docs></folder>`).join("") : "";
  const attrs = details ? p.attributes.map((a, i) => `<project_attribute id="00002_00000075${i}"><deleted>0</deleted><attribute_id>${a.id}</attribute_id><attribute_value>${esc(a.value)}</attribute_value></project_attribute>`).join("") : "";
  return `<project id="${p.id}"><deleted>0</deleted><name>${esc(p.name)}</name><description>${esc(p.description)}</description><manager_id>${p.managerId}</manager_id><manager_type>${p.managerType || "user"}</manager_type><customer_id/><created_date>${p.created}</created_date><modified_date>${p.modified}</modified_date><root_folder_docs_count>${documents.filter((d) => d.projectId === p.id && !d.folderId).length}</root_folder_docs_count><is_template>${p.template ? 1 : 0}</is_template><characteristic_list/><attribute_list>${attrs}</attribute_list><folder_list>${folders}</folder_list><status_id>${p.statusId}</status_id><due_date>${p.due}</due_date>${m ? `<manager id="${m.id}"><deleted>0</deleted><name>${m.name}</name><last_name>${esc(m.last)}</last_name><first_name>${esc(m.first)}</first_name><email>${esc(m.email)}</email></manager>` : ""}<thumbnail_url>thumbnails/project.gif</thumbnail_url><project_user_permission><permission><view>1</view><add>1</add><update>1</update><delete>1</delete><checkout>1</checkout><download>1</download><change_approval>1</change_approval><change_task>1</change_task><change_bom>1</change_bom><can_manage_this_project>1</can_manage_this_project></permission></project_user_permission></project>`;
}

function findProject(q) {
  const id = q.get("projectid");
  const name = q.get("projectname") ?? q.get("name");
  if (id) return projects.find((p) => p.id === id);
  if (name) return projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  return undefined;
}

function wildcard(pattern) {
  const re = "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return new RegExp(re, "i");
}

// ---- SDK pages -------------------------------------------------------------
const handlers = {
  "GetWebCenterAPI.jsp": () => `<application><doc title="WebCenter SDK API (mock)"/></application>`,

  "GetUserInfo.jsp": (q) => {
    const u = users.find((x) => x.id === q.get("askeduserid")) || users.find((x) => x.name === (q.get("askedusername") || "").toUpperCase());
    if (!q.get("askeduserid") && !q.get("askedusername")) return err("002", "One or more mandatory parameters were not specified");
    if (!u) return err("031", "Specified user doesn't exist");
    return `<user><username>${u.name}</username><user_id>${u.id}</user_id><first_name>${esc(u.first)}</first_name><last_name>${esc(u.last)}</last_name><company>${esc(u.company)}</company><company_location>${esc(u.location)}</company_location><e-mail>${esc(u.email)}</e-mail><phone_number></phone_number><function></function><ldap_user>0</ldap_user>${u.admin ? "<is_admin>1</is_admin>" : ""}<project_manager>${u.pm ? 1 : 0}</project_manager><project_creator>0</project_creator><is_active>1</is_active><groups>${u.admin ? "<group><group_name>ADMINS</group_name><group_id>00001_0000000001</group_id></group>" : ""}<group><group_name>USERS</group_name><group_id>00001_0000000002</group_id></group></groups></user>`;
  },

  "GetUsers.jsp": (q) => {
    const verbose = q.get("verbose") === "1";
    const flags = ["normalusers", "projectmanagers", "administrators", "projectcreators"].map((f) => q.get(f));
    const anySet = flags.some((f) => f !== undefined);
    const list = users.filter((u) => {
      if (!anySet) return true;
      if (q.get("administrators") === "1" && u.admin) return true;
      if (q.get("projectmanagers") === "1" && u.pm) return true;
      if (q.get("normalusers") === "1" && !u.pm && !u.admin) return true;
      return false;
    });
    return `<result><user_list>${list.map((u) => `<user id="${u.id}"><name>${u.name}</name><last_name>${esc(u.last)}</last_name><first_name>${esc(u.first)}</first_name>${verbose ? `<email>${esc(u.email)}</email><is_project_manager>${u.pm ? 1 : 0}</is_project_manager><deleted>0</deleted>` : ""}</user>`).join("")}</user_list></result>`;
  },

  "GetProjects.jsp": (q) => {
    const type = q.get("type");
    if (!type) return err("002", "One or more mandatory parameters were not specified");
    if (!["1", "2", "3", "5", "6"].includes(type)) return err("003", "Invalid parameter format and/or value");
    const details = q.get("details") === "1";
    let list = projects.filter((p) => !p.template);
    if (type === "5") list = projects.filter((p) => p.template);
    if (type === "3") list = list.filter((p) => p.managerId === users[0].id);
    if (type === "1") list = list.slice(0, 1);
    if (type === "6") {
      if (q.get("projectid")) list = projects.filter((p) => p.id === q.get("projectid"));
      else if (q.get("name")) {
        const tmpl = ["1", "true"].includes((q.get("gettemplates") || "").toLowerCase());
        list = projects.filter((p) => !!p.template === tmpl && wildcard(q.get("name")).test(p.name));
      } else return err("002", "One or more mandatory parameters were not specified");
    } else if (q.get("name")) {
      const re = wildcard(q.get("name"));
      list = list.filter((p) => re.test(p.name));
    }
    if (q.get("statusname")) list = list.filter((p) => p.status.toLowerCase() === q.get("statusname").toLowerCase());
    if (q.get("numdays")) {
      const cutoff = Date.now() - Number(q.get("numdays")) * 86400000;
      list = list.filter((p) => p.modified >= cutoff);
    }
    const total = list.length;
    const pagesize = Number(q.get("pagesize") || 2000);
    const curpage = Number(q.get("curpage") || 1);
    list = list.slice((curpage - 1) * pagesize, curpage * pagesize);
    return `<get_project_list><project_list>${list.map((p) => projectXml(p, details)).join("")}</project_list><total_filter_projects>${total}</total_filter_projects><total_projects>${projects.length}</total_projects></get_project_list>`;
  },

  "GetDocumentList.jsp": (q) => {
    if (!q.get("projectid") && !q.get("projectname")) return err("002", "One or more mandatory parameters were not specified");
    const p = findProject(q);
    if (!p) return err("011", "Specified project doesn't exist");
    let docs = documents.filter((d) => d.projectId === p.id);
    const fids = q.all("folderid"), fnames = q.all("foldername").map((s) => s.toLowerCase());
    if (fids.length || fnames.length) docs = docs.filter((d) => fids.includes(d.folderId) || fnames.includes(d.folderName.toLowerCase()));
    const attrs = q.get("attributeinfo") === "1";
    return `<document_list projectid="${p.id}">${docs.map((d) => {
      const a = userById(d.authorId);
      return `<document><document_version_id>${d.verId}</document_version_id><document_id>${d.docId}</document_id><folder_id>${d.folderId}</folder_id><folder_name>${esc(d.folderName)}</folder_name><document_name>${esc(d.name)}</document_name><encoded_file_name>abc123.grs</encoded_file_name><document_version>${d.version}</document_version><document_description>${esc(d.description)}</document_description><version_comments>${esc(d.comments)}</version_comments><doctype_id>00001_0000000005</doctype_id><file_size>${d.size}</file_size><creation_date>${d.created}</creation_date><author id="${a.id}"><first_name>${esc(a.first)}</first_name><last_name>${esc(a.last)}</last_name></author><approval_cycle_info>${esc(d.approval)}</approval_cycle_info><viewable>${d.viewable}</viewable><get_viewer>openannotator_mp.jsp?DocVer=${d.verId}</get_viewer>${attrs ? `<attribute_category><id>00002_0000005402</id><name>Packaging</name><user_units>imperial</user_units><atts><att><id>00002_0000005012</id><an>Brand</an><av>ACME</av><at>Text</at></att><att><id>00002_0000005013</id><an>Board</an><av>SBS 18pt</av><at>Text</at></att></atts></attribute_category>` : ""}</document>`;
    }).join("")}</document_list>`;
  },

  "GetDocumentHistory.jsp": (q) => {
    const id = q.get("documentid") || q.get("docid") || q.get("docversionid");
    let d;
    if (id) d = documents.find((x) => x.docId === id || x.verId === id);
    else if (q.get("documentname")) {
      const p = findProject(q);
      if (!p) return err("011", "Specified project doesn't exist");
      d = documents.find((x) => x.projectId === p.id && x.name.toLowerCase() === q.get("documentname").toLowerCase());
    } else return err("002", "One or more mandatory parameters were not specified");
    if (!d) return err("021", "Specified document doesn't exist");
    const approvalInfo = q.get("approvalinfo") === "1";
    const author = userById(d.authorId);
    const approver = users[2];
    const versions = [];
    for (let v = 1; v <= d.version; v++) {
      const last = v === d.version;
      const status = last ? (d.approval.startsWith("approval is not") ? "" : d.approval) : "Rejected";
      versions.push(`<document_version><version_number>${v}</version_number><version_comments>${last ? esc(d.comments) : "Earlier revision"}</version_comments><creation_date>2026-11-0${v} 10:00:00.0</creation_date><docID>${d.docId}</docID><docVersionID>${d.verId.slice(0, -1)}${v}</docVersionID><author><user><userID>${author.id}</userID><lastname>${esc(author.last)}</lastname><firstname>${esc(author.first)}</firstname></user></author><annotations/>${status ? `<document_approval_cycle_status>${last && status === "Pending" ? "Cycle Started" : "Cycle Finished"}</document_approval_cycle_status><document_approval_status>${status}</document_approval_status><stage_index>1</stage_index>` : ""}${approvalInfo && status ? `<stages><stage><stage_id>00002_0000000171</stage_id><name>Customer approval</name><index>1</index><stage_approval_status>${status}</stage_approval_status><approver_list><approver><user><userID>${approver.id}</userID><login>${approver.name}</login><lastname>${esc(approver.last)}</lastname><firstname>${esc(approver.first)}</firstname><email>${esc(approver.email)}</email><companyname>${esc(approver.company)}</companyname></user><approval_action><approval_status>${status}</approval_status><approval_date>2026-11-1${v} 16:30:00.0</approval_date><doc_version>${v}</doc_version><approval_comment>${status === "Rejected" ? "Logo too small" : ""}</approval_comment></approval_action><active_approver>${last ? 1 : 0}</active_approver></approver></approver_list></stage></stages>` : ""}</document_version>`);
    }
    const pending = d.approval === "Pending" ? `<approval_users><user><userID>${approver.id}</userID><lastname>${esc(approver.last)}</lastname><firstname>${esc(approver.first)}</firstname><email>${esc(approver.email)}</email><companyname>${esc(approver.company)}</companyname></user></approval_users>` : "<approval_users/>";
    return `<document_info><docID>${d.docId}</docID><document_name>${esc(d.name)}</document_name><description>${esc(d.description)}</description><modification_date>${d.created}</modification_date><permission><view>1</view><add>1</add><update>1</update><delete>1</delete><checkout>1</checkout><download>1</download><change_approval>1</change_approval></permission>${pending}${versions.join("")}</document_info>`;
  },

  "GetUserTodoList.jsp": (q) => {
    const asked = q.get("askedusername") ? users.find((u) => u.name === q.get("askedusername").toUpperCase()) : users[0];
    if (!asked) return err("031", "Specified user doesn't exist");
    const showTasks = q.get("showtasks") !== "0";
    const showApprovals = q.get("showapprovals") !== "0";
    const tasks = showTasks ? `<project_wc_task_list><project_wctask id="00002_0000000435"><project_id>${projects[0].id}</project_id><project_name>${esc(projects[0].name)}</project_name><created_date>1763000000000</created_date><due_date>1763900000000</due_date><description>Check dieline against spec</description><name>Structural review</name><task_type_name>Review</task_type_name><status id="00001_0000000002"><status_name>In Progress</status_name></status><is_complete>0</is_complete><doc_version_list><doc_version_pair id="${documents[0].verId}"><doc_name>${esc(documents[0].name)}</doc_name></doc_version_pair></doc_version_list></project_wctask></project_wc_task_list>` : "";
    const approvals = showApprovals ? `<document_approval_list><user_todo_view><doc_name>${esc(documents[0].name)}</doc_name><doc_version_id>${documents[0].verId}</doc_version_id><doc_id>${documents[0].docId}</doc_id><version_counter>${documents[0].version}</version_counter><version_author_name>${esc(users[1].last)}, ${esc(users[1].first)}</version_author_name><project_name>${esc(projects[0].name)}</project_name><project_id>${projects[0].id}</project_id><duedate>0</duedate><has_approval_due_date>0</has_approval_due_date></user_todo_view></document_approval_list>` : "";
    return `<todo_list><user id="${asked.id}"><name>${asked.name}</name><last_name>${esc(asked.last)}</last_name><first_name>${esc(asked.first)}</first_name><email>${esc(asked.email)}</email></user>${tasks}${approvals}</todo_list>`;
  },

  "GetGroupInfo.jsp": (q) => {
    const g = groups.find((x) => x.id === q.get("askedgroupid") || x.name.toLowerCase() === (q.get("askedgroupname") || "").toLowerCase());
    if (!q.get("askedgroupid") && !q.get("askedgroupname")) return err("002", "One or more mandatory parameters were not specified");
    if (!g) return err("081", "Specified group doesn't exist");
    return `<group><group_name>${esc(g.name)}</group_name><group_id>${g.id}</group_id><visibility_type>0</visibility_type><admin_rights><flex_right>USERS</flex_right></admin_rights><user_members>${g.members.map((u) => `<user_member><id>${u.id}</id><username>${u.name}</username><first_name>${esc(u.first)}</first_name><last_name>${esc(u.last)}</last_name></user_member>`).join("")}</user_members></group>`;
  },

  "GetAttributes.jsp": (q) => {
    const p = findProject(q);
    if (!p) return q.get("projectid") || q.get("projectname") ? err("011", "Specified project doesn't exist") : err("002", "One or more mandatory parameters were not specified");
    const docLevel = q.get("documentid") || q.get("documentname") || q.get("docverid");
    const taskLevel = q.get("taskid") || q.get("taskname");
    if (docLevel) {
      const d = documents.find((x) => x.projectId === p.id && (x.docId === q.get("documentid") || x.verId === q.get("docverid") || x.name.toLowerCase() === (q.get("documentname") || "").toLowerCase()));
      if (!d) return err("021", "Specified document doesn't exist");
      return `<attributes><attribute_category><id>00002_0000005402</id><name>Structural Specs</name><atts><att><id>00002_0000005012</id><an>Style</an><av>RTE</av><at>Text</at></att><att><id>00002_0000005013</id><an>Board</an><av>SBS 18pt</av><at>Text</at></att><att><id>00002_0000005020</id><an>Length</an><av>8.5</av><at>Length</at><au>in</au></att><att><id>00002_0000000201</id><an>Die Line</an><at>Document Reference</at><av>shipper-rsc.ARD</av><drs><dr><dn>shipper-rsc.ARD</dn><dvidx>1</dvidx><id>00002_0000003245</id><count>1</count><dv>00002_0000004101</dv><astat>Approved</astat></dr></drs></att></atts></attribute_category></attributes>`;
    }
    if (taskLevel) return err("121", "Specified task(s) not found or cannot be accessed");
    if (!p.attributes.length) return err("043", "No Attributes were found");
    return `<attributes><attribute_category><id>00002_0000005401</id><name>Project Info</name><atts>${p.attributes.map((a, i) => `<att><id>${a.id}</id><an>${i === 0 ? "Customer" : "Board Grade"}</an><av>${esc(a.value)}</av><at>Text</at></att>`).join("")}</atts></attribute_category></attributes>`;
  },

  "GetDocRefParentObjects.jsp": (q) => {
    const d = documents.find((x) => x.verId === q.get("docversionid") || x.name.toLowerCase() === (q.get("documentname") || "").toLowerCase());
    if (!q.get("docversionid") && !q.get("documentname")) return err("002", "One or more mandatory parameters were not specified");
    if (!d) return err("021", "Specified document doesn't exist");
    return `<docref_dependencies><source_doc_id><name>${esc(d.name)}</name><project_id>${d.projectId}</project_id><document_id>${d.docId}</document_id></source_doc_id><docs_dep><nr_items>1</nr_items><item><name>1001-carton.ARD</name><id>00002_0000004003</id><attr_id>00002_0000000201</attr_id></item></docs_dep><projects_dep><nr_items>1</nr_items><item><name>ACME-1001 Cereal Carton</name><id>00002_0000001001</id><attr_id>00002_0000000202</attr_id></item></projects_dep><tasks_dep><nr_items>0</nr_items></tasks_dep></docref_dependencies>`;
  },

  "GetDocRefChildDocument.jsp": (q) => {
    if (!q.get("docversionid")) return err("002", "One or more mandatory parameters were not specified");
    if (!documents.find((x) => x.verId === q.get("docversionid"))) return err("021", "Specified document doesn't exist");
    return `<document_list><document><name>shipper-rsc.ARD</name><doc_id>00002_0000003101</doc_id><version_id>00002_0000004101</version_id></document></document_list>`;
  },

  "GetDocRefParentDocument.jsp": (q) => {
    if (!q.get("docversionid")) return err("002", "One or more mandatory parameters were not specified");
    return `<document_list><document><name>1001-carton.ARD</name><doc_id>00002_0000003001</doc_id><version_id>00002_0000004003</version_id></document></document_list>`;
  },

  "GetProjectTasks.jsp": (q) => {
    const p = findProject(q);
    if (!q.get("taskid") && !p) return q.get("projectid") || q.get("projectname") ? err("011", "Specified project doesn't exist") : err("002", "One or more mandatory parameters were not specified");
    const pr = p || projects[0];
    const task = (id, name, status, done, owner) => `<project_wctask id="${id}"><project_id>${pr.id}</project_id><project_name>${esc(pr.name)}</project_name><created_date>1763000000000</created_date><due_date>1763900000000</due_date><estimated_date>1763800000000</estimated_date><modified_date>1763100000000</modified_date><description>${esc(name)} for ${esc(pr.name)}</description><name>${esc(name)}</name><task_type_name>Review</task_type_name><task_owner_id>${owner.id}</task_owner_id><task_owner_type>user</task_owner_type><status id="00001_000000000${done ? 4 : 2}"><status_name>${status}</status_name></status><is_complete>${done ? 1 : 0}</is_complete><doc_version_list><doc_version_pair id="${documents[0].verId}"><doc_name>${esc(documents[0].name)}</doc_name></doc_version_pair></doc_version_list><user id="${owner.id}"><name>${owner.name}</name><last_name>${esc(owner.last)}</last_name><first_name>${esc(owner.first)}</first_name><email>${esc(owner.email)}</email></user><specification_value_view_list><specification_value_view><attribute id="00002_0000000005"><name>Flute</name></attribute><attribute_value><attribute_id>00002_0000000005</attribute_id><value>B</value></attribute_value><is_required>1</is_required></specification_value_view></specification_value_view_list></project_wctask>`;
    return `<result>${task("00002_0000000435", "Structural review", "In Progress", false, users[1])}${task("00002_0000000436", "Sample cut", "Completed", true, users[0])}</result>`;
  },

  "GetCharacteristicsTree.jsp": (q) => {
    if (q.get("rootcharid") && q.get("rootcharid") !== "00002_0000000001") return err("061", "Specified characteristic doesn't exist");
    return `<char_tree><elem><name>Customer</name><id>00002_0000000001</id><children><elem><name>ACME Foods</name><id>00002_0000000006</id></elem><elem><name> BRANDCO</name><id>00002_0000000007</id></elem></children></elem><elem><name>Plant</name><id>00002_0000000010</id></elem></char_tree>`;
  },

  "GetProjectsFromCharacteristics.jsp": (q) => {
    if (!q.get("characteristicid") && !q.get("characteristicpath")) return err("002", "One or more mandatory parameters were not specified");
    return `<project_list>${projects.filter((p) => !p.template && p.name.startsWith("ACME")).map((p) => `<project id="${p.id}"><deleted>0</deleted><name>${esc(p.name)}</name><description>${esc(p.description)}</description><created_date>${p.created}</created_date><modified_date>${p.modified}</modified_date><is_template>0</is_template><status>1</status></project>`).join("")}</project_list>`;
  },

  "DocumentGetThumbnailData.jsp": (q) => {
    if (!q.get("docid") && !q.get("docverid")) return err("002", "One or more mandatory parameters were not specified");
    if (!documents.find((d) => d.docId === q.get("docid") || d.verId === q.get("docverid"))) return err("021", "Specified document doesn't exist");
    return { binary: TINY_PNG, type: "image/png" };
  },

  "ProjectGetThumbnailData.jsp": (q) => {
    if (!findProject(q)) return err("011", "Specified project doesn't exist");
    return { binary: TINY_PNG, type: "image/png" };
  },

  "DownloadDocument.jsp": (q) => {
    let d = q.get("docversionid") ? documents.find((x) => x.verId === q.get("docversionid")) : undefined;
    if (!d && q.get("documentname")) {
      const p = findProject(q);
      if (!p) return err("011", "Specified project doesn't exist");
      d = documents.find((x) => x.projectId === p.id && x.name.toLowerCase() === q.get("documentname").toLowerCase());
    }
    if (!q.get("docversionid") && !q.get("documentname")) return err("002", "One or more mandatory parameters were not specified");
    if (!d) return err("021", "Specified document doesn't exist");
    return { binary: Buffer.from(`MOCK FILE CONTENT for ${d.name}\n`), type: "application/octet-stream", filename: d.name };
  },

  "Search.jsp": (q) => {
    if (q.get("action") === "docs") return `<html><body><h1>Search.jsp documentation (mock)</h1></body></html>`;
    const type = q.get("newsearch");
    if (!type && !q.get("savedsearch")) return err("002", "One or more mandatory parameters were not specified");
    // The real output format is only documented live on the server; this is a placeholder shape.
    const rows = (type === "proj" ? projects.filter((p) => !p.template).map((p) => ({ "proj.name": p.name, "proj.status": p.status, id: p.id })) : documents.map((d) => ({ "doc.name": d.name, "proj.name": projects.find((p) => p.id === d.projectId).name, id: d.docId })));
    if ((q.get("format") || "").toLowerCase() === "json") return JSON.stringify({ mock: true, results: rows });
    return `<search mock="true">${rows.map((r) => `<row id="${r.id}"/>`).join("")}</search>`;
  },
};

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// ---- server ----------------------------------------------------------------
export function createMockServer() {
  return http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = parseParams(req, body);
    if (!q.page.startsWith(BASE_PATH)) { res.writeHead(404); return res.end("Not found"); }
    const pageName = q.page.slice(BASE_PATH.length);
    const handler = handlers[pageName];
    const send = (status, text, type = "text/xml; charset=UTF-8") => { res.writeHead(status, { "Content-Type": type }); res.end(text); };
    if (!handler) return send(404, "<html><body>404 Not Found</body></html>", "text/html");
    if (pageName === "GetWebCenterAPI.jsp") return send(200, handler(q));

    // Authentication: OAuth bearer token, or username + base64 password
    const auth = req.headers["authorization"] || "";
    const tokenOk = auth === "Bearer mock-token";
    if (!tokenOk) {
      const user = (q.get("username") || "").toUpperCase();
      if (user === "SSOUSER" && !q.get("ssoiid")) return send(200, "<html><head><title>Sign in</title></head><body>SAML login portal</body></html>", "text/html");
      if (user !== MOCK_USER && user !== "SSOUSER") return send(200, err("001", "User login failed"));
      if (q.get("password") !== MOCK_PASS_B64) return send(200, err("001", "User login failed"));
    }
    try {
      const out = handler(q);
      if (out && typeof out === "object" && out.binary) {
        const headers = { "Content-Type": out.type };
        if (out.filename) headers["Content-Disposition"] = `attachment; filename="${out.filename}"`;
        res.writeHead(200, headers);
        return res.end(out.binary);
      }
      send(200, out, out.startsWith("{") ? "application/json" : out.startsWith("<html") ? "text/html" : "text/xml; charset=UTF-8");
    } catch (e) {
      send(200, err("000", "Undefined error: " + e.message));
    }
  });
});
}

/** Start the mock on 127.0.0.1. Port 0 picks a free port. Resolves to the base URL. */
export function startMock(port = 0) {
  const server = createMockServer();
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}${BASE_PATH}` })));
}

// Run directly: node mock/server.mjs [port]
if ((process.argv[1] || "").replace(/\\/g, "/").endsWith("mock/server.mjs")) {
  startMock(PORT).then(({ baseUrl }) => console.error(`Mock WebCenter listening on ${baseUrl}  (login: ${MOCK_USER} / mockpass)`));
}
