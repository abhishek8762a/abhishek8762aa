// Super Admin: overview, workload, settings (steps / users / holidays / config), edit approvals, audit, emails
import { sb, rpc, q, fetchAll } from "../sb.js";
import { state, userName } from "../state.js";
import { esc, $, $$, fmtDT, fmtD, dueInfo, statusBadge, toast, toastError, selectBox, confirmBox, downloadCSV } from "../ui.js";

const TABS = [
  ["overview", "Overview"], ["workload", "Workload"], ["settings", "Settings"],
  ["edits", "Edit requests"], ["audit", "Audit log"], ["emails", "Emails"],
];

export async function renderAdmin(page, tab = "overview") {
  if (!TABS.some(([k]) => k === tab)) tab = "overview";
  page.innerHTML = `<h1>Super Admin</h1>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="${k === tab ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div id="tab"><div class="spinner"></div></div>`;
  $$(".tabs button", page).forEach((b) => b.onclick = () => { location.hash = `#/admin/${b.dataset.tab}`; });
  const box = $("#tab");
  const fn = { overview, workload, settings, edits, audit, emails }[tab];
  try { await fn(box); } catch (e) { box.innerHTML = `<div class="banner red">${esc(e.message)}</div>`; }
}

const TASK_SELECT = "id,po_number,lot_key,step_code,doer_email,status,planned_at,actual_at,created_at,attempt_no," +
  "purchase_orders(series,model_no,status,total_qty),lots(qty,status)";

// ---------------- overview ----------------
async function overview(box) {
  const pending = await fetchAll(() => sb.from("tasks").select(TASK_SELECT).eq("status", "PENDING").order("planned_at"));
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const [{ count: doneMonth }, { count: activePOs }] = await Promise.all([
    sb.from("tasks").select("id", { count: "exact", head: true }).eq("status", "DONE").gte("actual_at", monthStart.toISOString()),
    sb.from("purchase_orders").select("po_number", { count: "exact", head: true }).eq("status", "ACTIVE"),
  ]);
  const rows = pending.map((t) => ({ ...t, d: dueInfo(t), held: t.purchase_orders?.status === "ON_HOLD" || t.lots?.status === "ON_HOLD" }));
  const overdue = rows.filter((r) => r.d.cls === "overdue" && !r.held);

  const byStep = state.steps.map((s) => ({
    s, n: rows.filter((r) => r.step_code === s.step_code).length,
    od: overdue.filter((r) => r.step_code === s.step_code).length,
  }));
  const maxN = Math.max(1, ...byStep.map((x) => x.n));

  let fDoer = "", fStep = "", fOver = false, fText = "";
  box.innerHTML = `
    <div class="grid kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="v">${rows.length}</div><div class="l">Pending tasks</div></div>
      <div class="kpi red"><div class="v">${overdue.length}</div><div class="l">Overdue</div></div>
      <div class="kpi amber"><div class="v">${rows.filter((r) => r.d.cls === "today").length}</div><div class="l">Due today</div></div>
      <div class="kpi green"><div class="v">${doneMonth ?? 0}</div><div class="l">Done this month</div></div>
      <div class="kpi blue"><div class="v">${activePOs ?? 0}</div><div class="l">Active POs</div></div>
      <div class="kpi"><div class="v">${rows.filter((r) => r.held).length}</div><div class="l">On hold</div></div>
    </div>
    <div class="card"><h2>Bottlenecks — pending per step</h2>
      ${byStep.map((x) => `<div class="hbar"><div><span class="step">${x.s.step_code}</span> <span class="small">${esc(userName(x.s.doer_email))}</span></div>
        <div class="b"><div class="${x.od ? "red" : ""}" style="width:${(x.n / maxN) * 100}%"></div></div><div class="num small">${x.n}${x.od ? ` <span style="color:var(--red)">(${x.od})</span>` : ""}</div></div>`).join("")}
      <div class="small dim">Bracket me = overdue</div></div>
    <div class="card"><div class="spread"><h2 style="margin:0">All pending tasks</h2><button class="btn small" id="csv">⬇ CSV</button></div>
      <div class="row" style="margin:10px 0">
        <select id="f-doer" style="width:auto"><option value="">All doers</option>${state.users.map((u) => `<option value="${esc(u.email)}">${esc(u.full_name)}</option>`).join("")}</select>
        <select id="f-step" style="width:auto"><option value="">All steps</option>${state.steps.map((s) => `<option>${s.step_code}</option>`).join("")}</select>
        <label class="radio"><input type="checkbox" id="f-over"> Overdue only</label>
        <input id="f-text" placeholder="Search…" style="width:auto;flex:1;min-width:140px">
      </div>
      <div class="table-wrap"><table><thead><tr><th>Step</th><th>PO / Lot</th><th>Product</th><th>Doer</th><th>Due</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const filtered = () => rows.filter((r) => (!fDoer || r.doer_email === fDoer) && (!fStep || r.step_code === fStep)
    && (!fOver || r.d.cls === "overdue") && (!fText || `${r.po_number} ${r.lot_key} ${r.purchase_orders?.model_no}`.toLowerCase().includes(fText)));
  const draw = () => {
    const list = filtered();
    $("#rows").innerHTML = list.slice(0, 300).map((r) => `<tr>
      <td><span class="step">${r.step_code}</span>${r.attempt_no > 1 ? ` <span class="badge amber">#${r.attempt_no}</span>` : ""}</td>
      <td><a href="#/task/${r.id}">${esc(r.lot_key || r.po_number)}</a></td>
      <td class="small">${esc(r.purchase_orders?.series)} ${esc(r.purchase_orders?.model_no)} · ${r.lots?.qty ?? r.purchase_orders?.total_qty}</td>
      <td>${esc(userName(r.doer_email))}</td>
      <td class="nowrap">${r.held ? `<span class="badge">ON HOLD</span>` : `<span class="badge ${r.d.badge}">${esc(r.d.label)}</span>`}</td>
      <td><button class="btn small" data-reassign="${r.id}">Reassign</button></td></tr>`).join("")
      + (list.length > 300 ? `<tr><td colspan="6" class="dim small">${list.length - 300} more — filter use karein</td></tr>` : "")
      + (list.length ? "" : `<tr><td colspan="6" class="dim">Kuch nahi mila</td></tr>`);
  };
  draw();
  $("#f-doer").onchange = (e) => { fDoer = e.target.value; draw(); };
  $("#f-step").onchange = (e) => { fStep = e.target.value; draw(); };
  $("#f-over").onchange = (e) => { fOver = e.target.checked; draw(); };
  $("#f-text").oninput = (e) => { fText = e.target.value.toLowerCase(); draw(); };
  $("#rows").onclick = async (e) => {
    const b = e.target.closest("[data-reassign]");
    if (!b) return;
    const v = await selectBox("Reassign task", "New doer", state.users.filter((u) => u.is_active).map((u) => ({ value: u.email, label: `${u.full_name} (${u.email})` })));
    if (!v) return;
    try { await rpc("reassign_task", { p_task_id: Number(b.dataset.reassign), p_new_email: v }); toast("Reassign ho gaya"); overview(box); } catch (err) { toastError(err); }
  };
  $("#csv").onclick = () => downloadCSV("omex-pending-tasks.csv", filtered(), [
    { label: "Task", key: "id" }, { label: "Step", key: "step_code" }, { label: "PO", key: "po_number" }, { label: "Lot", key: "lot_key" },
    { label: "Model", get: (r) => r.purchase_orders?.model_no }, { label: "Doer", get: (r) => userName(r.doer_email) },
    { label: "Planned (IST)", get: (r) => fmtDT(r.planned_at) }, { label: "Status", get: (r) => (r.held ? "ON HOLD" : r.d.label) },
  ]);
}

// ---------------- workload ----------------
async function workload(box) {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const [pending, done] = await Promise.all([
    fetchAll(() => sb.from("tasks").select("doer_email,planned_at,created_at,step_code").eq("status", "PENDING")),
    fetchAll(() => sb.from("tasks").select("doer_email,planned_at,actual_at").eq("status", "DONE").gte("actual_at", since)),
  ]);
  const people = state.users.filter((u) => u.is_active);
  const rows = people.map((u) => {
    const p = pending.filter((t) => t.doer_email === u.email);
    const dn = done.filter((t) => t.doer_email === u.email);
    const ontime = dn.filter((t) => new Date(t.actual_at) <= new Date(t.planned_at)).length;
    return {
      u, pending: p.length,
      overdue: p.filter((t) => dueInfo(t).cls === "overdue").length,
      today: p.filter((t) => dueInfo(t).cls === "today").length,
      done: dn.length,
      ontimePct: dn.length ? Math.round((ontime / dn.length) * 100) : null,
      steps: [...new Set(p.map((t) => t.step_code))].join(", "),
    };
  });
  box.innerHTML = `<div class="card"><h2>Doer workload</h2><div class="table-wrap"><table>
    <thead><tr><th>Doer</th><th class="num">Pending</th><th class="num">Overdue</th><th class="num">Due today</th><th class="num">Done (30 d)</th><th class="num">On-time %</th><th>Steps pending</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td><b>${esc(r.u.full_name)}</b><div class="small dim">${esc(r.u.email)} · ${r.u.role}</div></td>
      <td class="num">${r.pending}</td><td class="num" style="color:${r.overdue ? "var(--red)" : ""}">${r.overdue}</td><td class="num">${r.today}</td>
      <td class="num">${r.done}</td><td class="num">${r.ontimePct == null ? "-" : r.ontimePct + "%"}</td><td class="small">${esc(r.steps)}</td></tr>`).join("")}</tbody></table></div></div>`;
}

// ---------------- settings ----------------
async function settings(box) {
  const [steps, users, holidays, config] = await Promise.all([
    q(sb.from("steps").select("*").order("step_order")),
    q(sb.from("app_users").select("*").order("full_name")),
    q(sb.from("holidays").select("*").order("holiday_date")),
    q(sb.from("app_config").select("*").order("key")),
  ]);
  const userOpts = (sel) => users.filter((u) => u.is_active).map((u) => `<option value="${esc(u.email)}" ${u.email === sel ? "selected" : ""}>${esc(u.full_name)}</option>`).join("");

  box.innerHTML = `
    <div class="card"><h2>Steps — TAT (working hours) & doer</h2>
      <div class="table-wrap"><table><thead><tr><th>Step</th><th>Type</th><th>TAT hrs</th><th>Doer</th></tr></thead><tbody>
      ${steps.map((s) => `<tr><td><span class="step">${s.step_code}</span> ${esc(s.step_name)}</td><td class="small">${s.step_type}</td>
        <td><input type="number" min="1" step="0.5" value="${s.tat_hours}" data-tat="${s.step_code}" style="width:100px"></td>
        <td><select data-doer="${s.step_code}" style="min-width:140px">${userOpts(s.doer_email)}</select></td></tr>`).join("")}
      </tbody></table></div>
      <p class="small dim">TAT badalne se sirf naye tasks par asar hoga. Doer badalne par pending tasks bhi move kar sakte hain.</p></div>

    <div class="card"><h2>Users</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.full_name)}</td><td class="small">${esc(u.email)}</td>
        <td><select data-role="${esc(u.email)}" style="width:auto">${["DOER", "SALES", "ADMIN"].map((r) => `<option ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}</select></td>
        <td><input type="checkbox" data-active="${esc(u.email)}" ${u.is_active ? "checked" : ""}></td></tr>`).join("")}
      </tbody></table></div>
      <form id="add-user" class="row" style="margin-top:10px">
        <input id="nu-name" placeholder="Name" required style="flex:1;min-width:120px">
        <input id="nu-email" type="email" placeholder="email@omexgears.com" required style="flex:2;min-width:180px">
        <select id="nu-role" style="width:auto"><option>DOER</option><option>SALES</option><option>ADMIN</option></select>
        <button class="btn primary">Add user</button></form>
      <p class="small dim">Naye user ka login bhi banana hoga: Supabase → Authentication → Users → Add user (same email).</p></div>

    <div class="card"><h2>Holidays</h2>
      <div class="small dim" style="margin-bottom:8px">Sunday already off hai. Yahan festival / company holidays daalein — TAT inko skip karega.</div>
      <div class="table-wrap"><table><tbody>${holidays.length ? holidays.map((h) => `<tr><td>${fmtD(h.holiday_date)}</td><td>${esc(h.description)}</td>
        <td class="right"><button class="btn small danger" data-del-hol="${h.holiday_date}">Delete</button></td></tr>`).join("") : `<tr><td class="dim">Koi holiday nahi</td></tr>`}</tbody></table></div>
      <form id="add-hol" class="row" style="margin-top:10px"><input type="date" id="h-date" required style="width:auto">
        <input id="h-desc" placeholder="Diwali" style="flex:1;min-width:120px"><button class="btn primary">Add</button></form></div>

    <div class="card"><h2>Config</h2><div class="table-wrap"><table><tbody>
      ${config.map((c) => `<tr><td class="mono">${esc(c.key)}<div class="small dim">${esc(c.description)}</div></td>
        <td><input value="${esc(c.value)}" data-cfg="${esc(c.key)}"></td></tr>`).join("")}</tbody></table></div>
      <button class="btn primary" id="save-cfg" style="margin-top:10px">Save config</button></div>`;

  const done = (msg) => { toast(msg); settings(box); };
  const check = async (p) => { const { error } = await p; if (error) throw new Error(error.message); };

  $$("[data-tat]", box).forEach((i) => i.onchange = async () => {
    try { await check(sb.from("steps").update({ tat_hours: Number(i.value), updated_at: new Date().toISOString() }).eq("step_code", i.dataset.tat)); toast(`${i.dataset.tat} TAT = ${i.value} hrs`); } catch (e) { toastError(e); }
  });
  $$("[data-doer]", box).forEach((s) => s.onchange = async () => {
    const move = await confirmBox(`${s.dataset.doer} doer badlein`, `Naye tasks ${userName(s.value)} ko jayenge. Abhi ke pending tasks bhi move karein?`, { okLabel: "Haan, move karo" });
    try {
      const res = await rpc("reassign_step", { p_step: s.dataset.doer, p_new_email: s.value, p_move_pending: move });
      state.steps = await q(sb.from("steps").select("*").order("step_order"));
      done(`${s.dataset.doer} → ${userName(s.value)} (${res.tasks_moved} pending moved)`);
    } catch (e) { toastError(e); }
  });
  $$("[data-role]", box).forEach((s) => s.onchange = async () => {
    try { await check(sb.from("app_users").update({ role: s.value }).eq("email", s.dataset.role)); toast("Role update"); } catch (e) { toastError(e); }
  });
  $$("[data-active]", box).forEach((c) => c.onchange = async () => {
    try { await check(sb.from("app_users").update({ is_active: c.checked }).eq("email", c.dataset.active)); toast("Saved"); } catch (e) { toastError(e); }
  });
  $("#add-user").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await check(sb.from("app_users").insert({ email: $("#nu-email").value.trim().toLowerCase(), full_name: $("#nu-name").value.trim().toUpperCase(), role: $("#nu-role").value }));
      state.users = await q(sb.from("app_users").select("*").order("full_name"));
      done("User add ho gaya");
    } catch (err) { toastError(err); }
  };
  $$("[data-del-hol]", box).forEach((b) => b.onclick = async () => {
    try { await check(sb.from("holidays").delete().eq("holiday_date", b.dataset.delHol)); done("Holiday delete"); } catch (e) { toastError(e); }
  });
  $("#add-hol").onsubmit = async (e) => {
    e.preventDefault();
    try { await check(sb.from("holidays").insert({ holiday_date: $("#h-date").value, description: $("#h-desc").value })); done("Holiday add"); } catch (err) { toastError(err); }
  };
  $("#save-cfg").onclick = async () => {
    try {
      for (const i of $$("[data-cfg]", box)) {
        const old = config.find((c) => c.key === i.dataset.cfg)?.value;
        if (old !== i.value) await check(sb.from("app_config").update({ value: i.value.trim() }).eq("key", i.dataset.cfg));
      }
      done("Config saved");
    } catch (e) { toastError(e); }
  };
}

// ---------------- edit requests ----------------
async function edits(box) {
  const reqs = await q(sb.from("edit_requests").select("*, tasks(step_code,lot_key,po_number)").order("created_at", { ascending: false }).limit(100));
  box.innerHTML = reqs.length ? reqs.map((r) => `<div class="card tight">
      <div class="spread"><div><b>${esc(r.tasks?.step_code)} · ${esc(r.tasks?.lot_key || r.tasks?.po_number)}</b> ${statusBadge(r.status)}
        <div class="small dim">${esc(userName(r.requested_by))} · ${fmtDT(r.created_at)} · Reason: ${esc(r.reason || "-")}</div></div>
        <a href="#/task/${r.task_id}" class="btn small ghost">Open task</a></div>
      <div class="grid two" style="margin-top:8px"><div><div class="small dim">Old</div><pre class="mono small" style="white-space:pre-wrap">${esc(JSON.stringify(r.old_data, null, 1))}</pre></div>
        <div><div class="small dim">New</div><pre class="mono small" style="white-space:pre-wrap">${esc(JSON.stringify(r.new_data, null, 1))}</pre></div></div>
      ${r.status === "PENDING" ? `<div class="row"><button class="btn primary small" data-ok="${r.id}">Approve</button><button class="btn danger small" data-no="${r.id}">Reject</button></div>` : ""}
    </div>`).join("") : `<div class="empty">Koi edit request nahi.</div>`;
  box.onclick = async (e) => {
    const ok = e.target.closest("[data-ok]"), no = e.target.closest("[data-no]");
    if (!ok && !no) return;
    try { await rpc("decide_edit", { p_request_id: Number((ok || no).dataset.ok || (ok || no).dataset.no), p_approve: !!ok }); toast(ok ? "Approved" : "Rejected"); edits(box); } catch (err) { toastError(err); }
  };
}

// ---------------- audit ----------------
async function audit(box) {
  const rows = await q(sb.from("audit_log").select("*").order("id", { ascending: false }).limit(300));
  box.innerHTML = `<input id="a-f" placeholder="Filter (PO, lot, user, action)…" style="margin-bottom:10px">
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody id="a-rows"></tbody></table></div>`;
  const draw = (f = "") => {
    $("#a-rows").innerHTML = rows.filter((r) => !f || JSON.stringify(r).toLowerCase().includes(f)).map((r) => `<tr>
      <td class="nowrap small">${fmtDT(r.created_at)}</td><td class="small">${esc(userName(r.actor_email))}</td><td><span class="badge">${esc(r.action)}</span></td>
      <td class="small">${esc(r.entity_type)} ${r.entity_type === "TASK" ? `<a href="#/task/${esc(r.entity_id)}">${esc(r.entity_id)}</a>` : esc(r.entity_id)}</td>
      <td class="mono small" style="max-width:360px;word-break:break-word">${esc(JSON.stringify(r.after_state ?? "")).slice(0, 220)}</td></tr>`).join("");
  };
  draw();
  $("#a-f").oninput = (e) => draw(e.target.value.toLowerCase());
}

// ---------------- emails ----------------
async function emails(box) {
  const rows = await q(sb.from("notifications").select("*").order("id", { ascending: false }).limit(150));
  const count = (s) => rows.filter((r) => r.status === s).length;
  box.innerHTML = `<div class="grid kpis" style="margin-bottom:12px">
      <div class="kpi amber"><div class="v">${count("PENDING")}</div><div class="l">Queued</div></div>
      <div class="kpi green"><div class="v">${count("SENT")}</div><div class="l">Sent</div></div>
      <div class="kpi red"><div class="v">${count("FAILED")}</div><div class="l">Failed</div></div></div>
    <p class="small dim">Last 150 notifications. Queued zyada der tak rahe to Edge Function / cron check karein (SETUP_GUIDE step 5).</p>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Kind</th><th>Subject</th><th>Status</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="nowrap small">${fmtDT(r.created_at)}</td><td class="small">${esc(userName(r.recipient_email))}${r.cc_email ? ` <span class="dim">cc ${esc(r.cc_email)}</span>` : ""}</td>
      <td><span class="badge">${esc(r.kind)}</span></td><td class="small">${esc(r.subject)}${r.error ? `<div style="color:var(--red)">${esc(r.error.slice(0, 160))}</div>` : ""}</td>
      <td>${statusBadge(r.status)}</td></tr>`).join("")}</tbody></table></div>`;
}
