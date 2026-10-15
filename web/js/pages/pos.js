// PO list with lot tree and current step of every lot (Sales + Super Admin)
import { rpc } from "../sb.js";
import { isAdmin, userName } from "../state.js";
import { esc, $, $$, fmtDT, fmtD, dueInfo, statusBadge, toast, toastError, promptBox, downloadCSV } from "../ui.js";

let statusFilter = "ACTIVE";
let search = "";

function lotRows(p) {
  const depth = { WO: 0, BO: 1, FG: 2 };
  return p.lots.map((l) => {
    const open = (l.open || []).map((o) => {
      const d = dueInfo(o);
      return `<a href="#/task/${o.id}" class="badge ${d.badge}" title="${esc(d.label)}">${esc(o.step)} · ${esc(userName(o.doer))}</a>`;
    }).join(" ");
    return `<div class="lot d${depth[l.stage]}">
      <b class="mono">${esc(l.lot_key)}</b> <span class="dim">${esc(l.stage)} · ${l.qty} pcs</span> ${statusBadge(l.status)}
      ${l.priority === "URGENT" ? `<span class="badge red">URGENT</span>` : ""} ${open}
      ${isAdmin() && ["ACTIVE", "ON_HOLD"].includes(l.status) ? `<span style="margin-left:auto" class="row">
        ${l.status === "ACTIVE" ? `<button class="btn small warn" data-act="hold" data-lot="${esc(l.lot_key)}">Hold</button>` : `<button class="btn small" data-act="resume" data-lot="${esc(l.lot_key)}">Resume</button>`}
        <button class="btn small danger" data-act="cancel" data-lot="${esc(l.lot_key)}">Cancel</button></span>` : ""}
    </div>`;
  }).join("");
}

export async function renderPOs(page) {
  const list = await rpc("po_progress", { p_status: statusFilter === "ALL" ? null : statusFilter });

  page.innerHTML = `
    <div class="spread"><h1>Purchase Orders</h1><button class="btn small" id="csv">⬇ CSV</button></div>
    <div class="chips">${["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED", "ALL"].map((s) => `<button class="chip ${s === statusFilter ? "on" : ""}" data-s="${s}">${s}</button>`).join("")}</div>
    <input id="search" placeholder="Search PO / model / lot…" value="${esc(search)}" style="margin-bottom:12px">
    <div id="list"></div>`;

  const draw = () => {
    const s = search.toLowerCase();
    const rows = list.filter((p) => !s || [p.po.po_number, p.po.model_no, p.po.series, p.po.lot_label, ...p.lots.map((l) => l.lot_key + " " + (l.legacy_key || ""))].join(" ").toLowerCase().includes(s));
    $("#list").innerHTML = rows.length ? rows.map((p) => {
      const pct = p.po.total_qty ? Math.round((p.assigned_qty / p.po.total_qty) * 100) : 0;
      const s1 = (p.po_open || [])[0];
      return `<div class="card tight">
        <div class="spread"><div><b>${esc(p.po.po_number)}</b> ${statusBadge(p.po.status)} ${p.po.priority === "URGENT" ? `<span class="badge red">URGENT</span>` : ""}
          <div class="small dim">${esc(p.po.series)} ${esc(p.po.model_no)} · ${p.po.total_qty} pcs${p.po.lot_label ? ` · ${esc(p.po.lot_label)}` : ""} · ${fmtD(p.po.created_at)}${p.po.expected_delivery ? ` · delivery ${fmtD(p.po.expected_delivery)}` : ""}</div></div>
          ${isAdmin() && ["ACTIVE", "ON_HOLD"].includes(p.po.status) ? `<div class="row">
            ${p.po.status === "ACTIVE" ? `<button class="btn small warn" data-act="hold" data-po="${esc(p.po.po_number)}">Hold PO</button>` : `<button class="btn small" data-act="resume" data-po="${esc(p.po.po_number)}">Resume PO</button>`}
            <button class="btn small danger" data-act="cancel" data-po="${esc(p.po.po_number)}">Cancel PO</button></div>` : ""}
        </div>
        <div class="alloc" style="margin:8px 0"><div class="bar"><div class="fill" style="width:${pct}%"></div></div>
          <div class="small dim">Clients ko assign: ${p.assigned_qty} / ${p.po.total_qty} · Split baaki: ${p.balance_to_split}
          ${s1 ? ` · <a href="#/task/${s1.id}">S1 pending (due ${fmtDT(s1.planned_at)})</a>` : ""}</div></div>
        <details ${p.lots.length && p.lots.length <= 6 ? "open" : ""}><summary>${p.lots.length} lots</summary>${lotRows(p)}</details>
      </div>`;
    }).join("") : `<div class="empty">Koi PO nahi mila.</div>`;
  };
  draw();

  $$(".chip", page).forEach((b) => b.onclick = () => { statusFilter = b.dataset.s; renderPOs(page); });
  $("#search").oninput = (e) => { search = e.target.value; draw(); };
  $("#csv").onclick = () => downloadCSV(`omex-po-lots-${statusFilter}.csv`, list.flatMap((p) => (p.lots.length ? p.lots : [{}]).map((l) => ({ p, l }))), [
    { label: "PO", get: (r) => r.p.po.po_number },
    { label: "PO status", get: (r) => r.p.po.status },
    { label: "Lot/Plan", get: (r) => r.p.po.lot_label },
    { label: "Series", get: (r) => r.p.po.series },
    { label: "Model", get: (r) => r.p.po.model_no },
    { label: "PO qty", get: (r) => r.p.po.total_qty },
    { label: "Lot", get: (r) => r.l.lot_key },
    { label: "Old unique no.", get: (r) => r.l.legacy_key },
    { label: "Stage", get: (r) => r.l.stage },
    { label: "Lot qty", get: (r) => r.l.qty },
    { label: "Lot status", get: (r) => r.l.status },
    { label: "Open step", get: (r) => (r.l.open || []).map((o) => `${o.step} (${userName(o.doer)})`).join("; ") },
  ]);

  $("#list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const po = b.dataset.po || null, lot = b.dataset.lot || null, what = lot || po;
    try {
      if (b.dataset.act === "hold") {
        const r = await promptBox(`Hold ${what}`, "Reason", { okLabel: "Hold" });
        if (!r) return;
        await rpc("hold_work", { p_po: po, p_lot: lot, p_reason: r });
        toast(`${what} hold par`);
      } else if (b.dataset.act === "resume") {
        const res = await rpc("resume_work", { p_po: po, p_lot: lot });
        toast(`${what} resume — ${res.tasks_shifted} task ki due date ${res.hold_hours} working hr aage`);
      } else if (b.dataset.act === "cancel") {
        const r = await promptBox(`Cancel ${what}?`, "Reason (cancel ki gayi qty wapas balance me nahi aayegi)", { okLabel: "Cancel", danger: true });
        if (!r) return;
        await rpc("cancel_work", { p_po: po, p_lot: lot, p_reason: r });
        toast(`${what} cancel ho gaya`);
      }
      renderPOs(page);
    } catch (err) { toastError(err); }
  });
}
