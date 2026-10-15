// Task detail: step form + Mark Done / Split / Assign / Reject, history of the lot, admin actions.
import { sb, rpc, q } from "../sb.js";
import { state, isAdmin, isSales, prevStepOf, userName } from "../state.js";
import { esc, $, $$, el, fmtDT, fmtD, dueInfo, statusBadge, toast, toastError, promptBox, selectBox, confirmBox, drafts, busy, todayISO } from "../ui.js";
import { STEP_FORMS, renderFields, wireFields, collectFields, pickedFiles, renderData } from "../forms.js";
import { updateBadge } from "../app.js";

// ---------- file upload / open ----------
async function uploadFiles(files, task) {
  const out = [];
  for (const f of files) {
    const safe = f.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${task.po_number.replace(/\//g, "-")}/${(task.lot_key || "PO").replace(/\//g, "-")}/${task.step_code}/${Date.now()}-${safe}`;
    const { error } = await sb.storage.from("fms-files").upload(path, f, { upsert: false });
    if (error) throw new Error(`Upload failed (${f.name}): ${error.message}`);
    out.push({ path, name: f.name });
  }
  return out;
}

export function wireFileLinks(root) {
  $$("[data-file-path]", root).forEach((a) => a.onclick = async (e) => {
    e.preventDefault();
    const { data, error } = await sb.storage.from("fms-files").createSignedUrl(a.dataset.filePath, 3600);
    if (error) return toastError(error);
    window.open(data.signedUrl, "_blank", "noopener");
  });
}

// ---------- split / assign row editors ----------
function splitRow(cfg, r = {}) {
  return `<tr>
    <td><input type="number" name="qty" min="1" step="1" inputmode="numeric" value="${esc(r.qty ?? "")}" style="min-width:70px"></td>
    ${cfg.needDate ? `<td><input type="date" name="planned_date" value="${esc(r.planned_date ?? "")}" min="${todayISO()}"></td>` : ""}
    ${cfg.showPriority ? `<td><select name="priority"><option ${r.priority === "URGENT" ? "" : "selected"}>NORMAL</option><option ${r.priority === "URGENT" ? "selected" : ""}>URGENT</option></select></td>` : ""}
    <td><input name="remarks" value="${esc(r.remarks ?? "")}" placeholder="optional"></td>
    <td><button type="button" class="btn ghost small" data-del>✕</button></td></tr>`;
}

function assignRow(r = {}) {
  return `<tr>
    <td><input name="client_name" list="clients" value="${esc(r.client_name ?? "")}" style="min-width:140px"></td>
    <td><input type="number" name="qty" min="1" step="1" inputmode="numeric" value="${esc(r.qty ?? "")}" style="min-width:70px"></td>
    <td><input name="invoice_no" value="${esc(r.invoice_no ?? "")}"></td>
    <td><input type="number" name="invoice_value" value="${esc(r.invoice_value ?? "")}"></td>
    <td><input type="date" name="dispatch_date" value="${esc(r.dispatch_date ?? "")}"></td>
    <td><input name="transporter" value="${esc(r.transporter ?? "")}"></td>
    <td><input name="lr_no" value="${esc(r.lr_no ?? "")}"></td>
    <td><button type="button" class="btn ghost small" data-del>✕</button></td></tr>`;
}

function readRows(tbody) {
  return $$("tr", tbody).map((tr) => {
    const r = {};
    $$("input,select", tr).forEach((i) => { const v = i.value.trim(); if (v !== "") r[i.name] = i.type === "number" ? Number(v) : v; });
    return r;
  }).filter((r) => Object.keys(r).length);
}

function allocHtml() {
  return `<div class="alloc"><div class="bar"><div class="fill" style="width:0"></div></div><div class="txt"></div></div>`;
}

function updateAlloc(box, used, balance, total) {
  const already = total - balance;
  const pct = total ? Math.min(100, ((already + used) / total) * 100) : 0;
  box.classList.toggle("over", used > balance);
  $(".fill", box).style.width = pct + "%";
  $(".txt", box).textContent = used > balance
    ? `Zyada ho gaya: ${used} / ${balance} balance`
    : `Ab: ${used} pcs · Pehle se: ${already} · Total ${already + used} / ${total} · Bachega: ${balance - used}`;
}

// ---------- page ----------
export async function renderTask(page, id) {
  const d = await rpc("get_task_detail", { p_task_id: id });
  const t = d.task, step = d.step, po = d.po, lot = d.lot;
  const form = STEP_FORMS[t.step_code] || { fields: [] };
  const mine = t.doer_email === state.email || isAdmin();
  const held = po.status === "ON_HOLD" || lot?.status === "ON_HOLD";
  const cancelled = po.status === "CANCELLED" || lot?.status === "CANCELLED";
  const canAct = t.status === "PENDING" && mine && !held && !cancelled;
  const due = dueInfo(t);
  const prev = prevStepOf(t.step_code);
  const draftKey = `task-${t.id}`;
  const draft = canAct ? drafts.get(draftKey) : null;
  const total = t.lot_key ? lot.qty : po.total_qty;

  page.innerHTML = `
    <a href="#/tasks" class="btn ghost small" style="margin-bottom:10px">← My Tasks</a>
    <div class="card">
      <div class="spread"><h1 style="margin:0"><span class="step">${esc(t.step_code)}</span> ${esc(step.step_name)}</h1>${statusBadge(t.status)}</div>
      <div class="kv" style="margin-top:10px">
        <div>PO</div><div><b>${esc(po.po_number)}</b>${po.lot_label ? ` · ${esc(po.lot_label)}` : ""}</div>
        ${t.lot_key ? `<div>Lot</div><div><b>${esc(t.lot_key)}</b> ${lot.legacy_key ? `<span class="dim small">(old: ${esc(lot.legacy_key)})</span>` : ""}</div>` : ""}
        <div>Product</div><div>${esc(po.series)} ${esc(po.model_no)}</div>
        <div>Qty</div><div><b>${esc(total)}</b>${t.lot_key ? ` <span class="dim small">(PO total ${esc(po.total_qty)})</span>` : ""}</div>
        <div>Doer</div><div>${esc(userName(t.doer_email))}</div>
        <div>Due</div><div class="${t.status === "PENDING" ? "" : "dim"}">${fmtDT(t.planned_at)} ${t.status === "PENDING" ? `<span class="badge ${due.badge}">${esc(due.label)}</span>` : ""}</div>
        ${t.actual_at ? `<div>Done</div><div>${fmtDT(t.actual_at)}${t.done_by ? ` by ${esc(userName(t.done_by))}` : ""}</div>` : ""}
        ${t.attempt_no > 1 ? `<div>Attempt</div><div><span class="badge amber">Rework #${t.attempt_no}</span></div>` : ""}
        ${(lot?.priority ?? po.priority) === "URGENT" ? `<div>Priority</div><div><span class="badge red">URGENT</span></div>` : ""}
        ${lot?.planned_date ? `<div>Lot planned date</div><div>${fmtD(lot.planned_date)}</div>` : ""}
        ${t.remarks ? `<div>Remarks</div><div>${esc(t.remarks)}</div>` : ""}
        ${t.rejection_reason ? `<div>Reason</div><div>${esc(t.rejection_reason)}</div>` : ""}
      </div>
    </div>
    ${held ? `<div class="banner hold">⏸ Ye ${po.status === "ON_HOLD" ? "PO" : "lot"} abhi HOLD par hai. Super Admin resume karega tab kaam hoga.</div>` : ""}
    ${cancelled ? `<div class="banner red">Ye ${po.status === "CANCELLED" ? "PO" : "lot"} cancel ho chuka hai.</div>` : ""}
    ${t.status === "PENDING" && !mine ? `<div class="banner info">Ye task ${esc(userName(t.doer_email))} ka hai.</div>` : ""}
    <div id="action"></div>
    <div id="admin"></div>
    <div class="card"><details ${t.status === "PENDING" ? "" : "open"}><summary>History (${d.history.length})</summary>
      <div class="timeline" style="margin-top:12px">${d.history.map((h) => `
        <div class="tl-item ${esc(h.status)}">
          <div class="row"><span class="step">${esc(h.step_code)}</span> <b>${esc(h.step_name)}</b> ${statusBadge(h.status)}
            ${h.attempt_no > 1 ? `<span class="badge amber">#${h.attempt_no}</span>` : ""}
            ${h.id === t.id ? `<span class="badge blue">this task</span>` : isSales() || h.doer_email === state.email ? `<a href="#/task/${h.id}" class="small">open</a>` : ""}</div>
          <div class="small dim">${esc(h.lot_key || "PO level")} · ${esc(userName(h.doer_email))} · planned ${fmtDT(h.planned_at)}${h.actual_at ? ` · actual ${fmtDT(h.actual_at)}` : ""}</div>
          ${h.rejection_reason ? `<div class="small" style="color:var(--red)">Reason: ${esc(h.rejection_reason)}</div>` : ""}
          ${h.remarks ? `<div class="small">💬 ${esc(h.remarks)}</div>` : ""}
          ${renderData(h.step_code, h.data)}
        </div>`).join("")}</div></details></div>`;

  const action = $("#action");

  // ----- DONE / other: show data + edit option -----
  if (t.status !== "PENDING") {
    const children = d.children.length ? `<div class="kv"><div>Lots</div><div>${d.children.map((c) => `${esc(c.lot_key)} (${c.qty}) ${statusBadge(c.status)}`).join("<br>")}</div></div>` : "";
    const assigns = d.assignments.length ? `<div class="kv"><div>Clients</div><div>${d.assignments.map((a) => `${esc(a.client_name)} — ${a.qty}${a.invoice_no ? ` · Inv ${esc(a.invoice_no)}` : ""}`).join("<br>")}</div></div>` : "";
    const canEdit = t.status === "DONE" && (isAdmin() || t.doer_email === state.email || t.done_by === state.email) && form.fields.length > 0;
    const withinWindow = t.actual_at && Date.now() - new Date(t.actual_at).getTime() < d.edit_window_minutes * 60e3;
    action.innerHTML = `<div class="card"><h2>Submitted data</h2>${renderData(t.step_code, t.data) || `<div class="dim">Koi extra data nahi.</div>`}${children}${assigns}
      ${canEdit ? `<button class="btn" id="edit" style="margin-top:12px">${isAdmin() || withinWindow ? "✎ Edit data" : "✎ Request edit (admin approval)"}</button>` : ""}</div>`;
    wireFileLinks(page);
    if (canEdit) $("#edit").onclick = () => openEdit(t, form, page, isAdmin() || withinWindow);
    renderAdminTools(t, po, lot, page);
    return;
  }

  if (!canAct) {
    wireFileLinks(page);
    renderAdminTools(t, po, lot, page);
    return;
  }

  // ----- PENDING and actionable -----
  const fieldValues = draft?.fields ?? t.data ?? {};
  let html = `<form class="card" id="step-form"><h2>Fill & submit</h2>
    ${form.hint ? `<div class="banner info small">${esc(form.hint)}</div>` : ""}
    ${draft ? `<div class="banner ok small">Draft restore hua (phone me save tha).</div>` : ""}
    <div class="form-grid">${renderFields(t.step_code, fieldValues)}</div>`;

  if (form.split) {
    const rows = draft?.rows ?? [{ qty: t.balance }];
    html += `<h3 style="margin-top:8px">${esc(form.split.title)} — balance <b>${t.balance}</b></h3>
      ${d.children.length ? `<div class="small dim" style="margin-bottom:6px">Pehle bane lots: ${d.children.map((c) => `${esc(c.lot_key)} (${c.qty})`).join(", ")}</div>` : ""}
      <div class="table-wrap"><table class="rows-table" id="split"><thead><tr><th class="req">Qty</th>
        ${form.split.needDate ? `<th class="req">Planned date</th>` : ""}${form.split.showPriority ? "<th>Priority</th>" : ""}<th>Remarks</th><th></th></tr></thead>
        <tbody>${rows.map((r) => splitRow(form.split, r)).join("")}</tbody></table></div>
      <button type="button" class="btn small" id="add-row" style="margin-top:6px">+ Add split</button>
      ${allocHtml()}`;
  } else if (form.assign) {
    const rows = draft?.rows ?? [{ qty: t.balance }];
    const clients = await q(sb.from("client_assignments").select("client_name").order("id", { ascending: false }).limit(1000));
    html += `<datalist id="clients">${[...new Set(clients.map((c) => c.client_name))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <h3 style="margin-top:8px">Client assignment — balance <b>${t.balance}</b></h3>
      ${d.assignments.length ? `<div class="small dim" style="margin-bottom:6px">Pehle assign: ${d.assignments.map((a) => `${esc(a.client_name)} (${a.qty})`).join(", ")}</div>` : ""}
      <div class="table-wrap"><table class="rows-table" id="split"><thead><tr><th class="req">Client</th><th class="req">Qty</th><th>Invoice no.</th><th>Invoice ₹</th><th>Dispatch date</th><th>Transporter</th><th>LR no.</th><th></th></tr></thead>
        <tbody>${rows.map((r) => assignRow(r)).join("")}</tbody></table></div>
      <button type="button" class="btn small" id="add-row" style="margin-top:6px">+ Add client</button>
      ${allocHtml()}`;
  }

  html += `<div class="field" style="margin-top:12px"><label class="f">Remarks</label><textarea id="remarks" maxlength="500">${esc(draft?.remarks ?? "")}</textarea></div>
    <div class="row">
      <button class="btn primary big" id="submit" style="flex:1">${form.split ? "Create lot(s)" : form.assign ? "Assign" : "✓ Mark Done"}</button>
      ${prev && step.step_type !== "ASSIGN" ? `<button type="button" class="btn danger big" id="reject">↩ Reject to ${esc(prev.step_code)}</button>` : ""}
    </div></form>`;
  action.innerHTML = html;

  const formEl = $("#step-form");
  const saveDraft = () => drafts.set(draftKey, {
    fields: collectFields(t.step_code, formEl, t.data),
    remarks: $("#remarks").value,
    rows: $("#split") ? readRows($("#split tbody")) : undefined,
  });
  wireFields(t.step_code, formEl, saveDraft);
  formEl.addEventListener("input", saveDraft);

  // split / assign editor
  const submit = $("#submit");
  if (form.split || form.assign) {
    const tbody = $("#split tbody");
    const alloc = $(".alloc", formEl);
    const check = () => {
      const rows = readRows(tbody);
      const used = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      updateAlloc(alloc, used, t.balance, total);
      const badRow = rows.some((r) => !(Number.isInteger(r.qty) && r.qty > 0)
        || (form.split?.needDate && !r.planned_date)
        || (form.assign && !r.client_name));
      submit.disabled = rows.length === 0 || used <= 0 || used > t.balance || badRow;
    };
    $("#add-row").onclick = () => {
      tbody.appendChild(el(`<table><tbody>${form.split ? splitRow(form.split) : assignRow()}</tbody></table>`).querySelector("tr"));
      check();
    };
    tbody.addEventListener("click", (e) => { if (e.target.closest("[data-del]")) { e.target.closest("tr").remove(); check(); saveDraft(); } });
    tbody.addEventListener("input", check);
    check();
  }

  formEl.onsubmit = async (e) => {
    e.preventDefault();
    busy(submit, true);
    try {
      const data = collectFields(t.step_code, formEl, t.data);
      const files = pickedFiles(t.step_code, formEl);
      if (files.length) data.attachments = [...(data.attachments || []), ...(await uploadFiles(files, t))];
      const remarks = $("#remarks").value.trim() || null;

      if (form.split) {
        const parts = readRows($("#split tbody"));
        const sum = parts.reduce((s, r) => s + r.qty, 0);
        if (!(await confirmBox("Confirm split", `${parts.length} lot (${sum} pcs) banenge. Balance bachega: ${t.balance - sum}.`, { okLabel: "Create" }))) { busy(submit, false); return; }
        const res = await rpc("split_task", { p_task_id: t.id, p_parts: parts, p_data: data, p_remarks: remarks });
        drafts.clear(draftKey);
        toast(`${res.created.length} lot bane: ${res.created.map((c) => c.lot_key).join(", ")}`);
        updateBadge();
        if (res.task_done) location.hash = "#/tasks"; else renderTask(page, t.id);
      } else if (form.assign) {
        const rows = readRows($("#split tbody")).map((r) => (data.attachments ? { ...r, attachments: data.attachments } : r));
        const res = await rpc("assign_clients", { p_task_id: t.id, p_rows: rows, p_remarks: remarks });
        drafts.clear(draftKey);
        toast(res.task_done ? "Poori qty assign ho gayi ✓" : `Assign ho gaya. Balance: ${res.balance}`);
        updateBadge();
        if (res.task_done) location.hash = "#/tasks"; else renderTask(page, t.id);
      } else {
        await rpc("complete_task", { p_task_id: t.id, p_data: data, p_remarks: remarks });
        drafts.clear(draftKey);
        toast(`${t.step_code} done ✓ — agla step assign ho gaya`);
        updateBadge();
        location.hash = "#/tasks";
      }
    } catch (err) {
      toastError(err);
      busy(submit, false);
    }
  };

  const rej = $("#reject");
  if (rej) rej.onclick = async () => {
    const reason = await promptBox(`Reject to ${prev.step_code} (${prev.step_name})`, "Reason — kya galat hai?", { okLabel: "Reject", danger: true });
    if (!reason) return;
    try {
      await rpc("reject_task", { p_task_id: t.id, p_reason: reason });
      drafts.clear(draftKey);
      toast(`${prev.step_code} dobara khul gaya (${userName(prev.doer_email)})`);
      updateBadge();
      location.hash = "#/tasks";
    } catch (err) { toastError(err); }
  };

  wireFileLinks(page);
  renderAdminTools(t, po, lot, page);
}

// ---------- edit after submit ----------
function openEdit(t, form, page, direct) {
  const box = $("#action");
  box.innerHTML = `<form class="card" id="edit-form"><h2>Edit ${esc(t.step_code)} data</h2>
    ${direct ? "" : `<div class="banner info small">1 ghante se zyada ho gaya — Super Admin approve karega.</div>`}
    <div class="form-grid">${renderFields(t.step_code, t.data)}</div>
    ${direct ? "" : `<div class="field"><label class="f req">Reason</label><input id="why" required></div>`}
    <div class="row"><button class="btn primary" id="save">${direct ? "Save" : "Send request"}</button>
    <button type="button" class="btn ghost" id="cancel">Cancel</button></div></form>`;
  const f = $("#edit-form");
  wireFields(t.step_code, f);
  $("#cancel").onclick = () => renderTask(page, t.id);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#save");
    busy(btn, true);
    try {
      const data = collectFields(t.step_code, f, t.data);
      const files = pickedFiles(t.step_code, f);
      if (files.length) data.attachments = [...(data.attachments || []), ...(await uploadFiles(files, t))];
      const res = await rpc("edit_task_data", { p_task_id: t.id, p_data: data, p_reason: $("#why")?.value || null });
      toast(res.status === "UPDATED" ? "Data update ho gaya" : "Request bhej di — admin approve karega");
      renderTask(page, t.id);
    } catch (err) { toastError(err); busy(btn, false); }
  };
}

// ---------- super admin tools ----------
function renderAdminTools(t, po, lot, page) {
  if (!isAdmin()) return;
  const box = $("#admin");
  const lotHeld = lot?.status === "ON_HOLD", poHeld = po.status === "ON_HOLD";
  box.innerHTML = `<div class="card"><h3>Super Admin</h3><div class="row">
    ${t.status === "PENDING" ? `<button class="btn small" id="a-reassign">👤 Reassign</button>` : ""}
    ${lot && lot.status === "ACTIVE" ? `<button class="btn small warn" id="a-hold-lot">⏸ Hold lot</button>` : ""}
    ${lotHeld ? `<button class="btn small" id="a-resume-lot">▶ Resume lot</button>` : ""}
    ${po.status === "ACTIVE" ? `<button class="btn small warn" id="a-hold-po">⏸ Hold PO</button>` : ""}
    ${poHeld ? `<button class="btn small" id="a-resume-po">▶ Resume PO</button>` : ""}
    ${lot && ["ACTIVE", "ON_HOLD"].includes(lot.status) ? `<button class="btn small danger" id="a-cancel-lot">✕ Cancel lot</button>` : ""}
    <a class="btn small ghost" href="#/pos">PO list</a>
  </div></div>`;
  const run = async (fn, msg) => { try { await fn(); toast(msg); renderTask(page, t.id); } catch (e) { toastError(e); } };
  const on = (id, f) => { const b = $(id); if (b) b.onclick = f; };

  on("#a-reassign", async () => {
    const v = await selectBox("Reassign task", "New doer", state.users.filter((u) => u.is_active).map((u) => ({ value: u.email, label: `${u.full_name} (${u.email})` })));
    if (v) run(() => rpc("reassign_task", { p_task_id: t.id, p_new_email: v }), "Reassign ho gaya");
  });
  on("#a-hold-lot", async () => {
    const r = await promptBox(`Hold ${lot.lot_key}`, "Reason", { okLabel: "Hold" });
    if (r) run(() => rpc("hold_work", { p_po: null, p_lot: lot.lot_key, p_reason: r }), "Lot hold par");
  });
  on("#a-resume-lot", () => run(() => rpc("resume_work", { p_po: null, p_lot: lot.lot_key }), "Lot resume — due dates aage badh gayi"));
  on("#a-hold-po", async () => {
    const r = await promptBox(`Hold ${po.po_number}`, "Reason", { okLabel: "Hold" });
    if (r) run(() => rpc("hold_work", { p_po: po.po_number, p_lot: null, p_reason: r }), "PO hold par");
  });
  on("#a-resume-po", () => run(() => rpc("resume_work", { p_po: po.po_number, p_lot: null }), "PO resume — due dates aage badh gayi"));
  on("#a-cancel-lot", async () => {
    const r = await promptBox(`Cancel ${lot.lot_key}?`, "Reason (qty wapas balance me NAHI aayegi)", { okLabel: "Cancel lot", danger: true });
    if (r) run(() => rpc("cancel_work", { p_po: null, p_lot: lot.lot_key, p_reason: r }), "Lot cancel ho gaya");
  });
}
