// Doer dashboard: my pending tasks, colour coded, + recently done (for edits)
import { sb, q } from "../sb.js";
import { state } from "../state.js";
import { esc, $, $$, dueInfo, fmtDT } from "../ui.js";

let filter = "all";
let search = "";

function taskCard(t) {
  const po = t.purchase_orders || {};
  const lot = t.lots;
  const held = po.status === "ON_HOLD" || lot?.status === "ON_HOLD";
  const d = dueInfo(t);
  const qty = lot?.qty ?? po.total_qty;
  const urgent = (lot?.priority ?? po.priority) === "URGENT";
  return `<a class="task ${held ? "hold" : d.cls}" href="#/task/${t.id}">
    <div class="t1"><span class="step">${esc(t.step_code)}</span> ${esc(t.steps?.step_name)}
      ${urgent ? `<span class="badge red">URGENT</span>` : ""}
      ${held ? `<span class="badge">ON HOLD</span>` : ""}
      ${t.attempt_no > 1 ? `<span class="badge amber">Rework #${t.attempt_no}</span>` : ""}</div>
    <div class="t2">${esc(t.lot_key || t.po_number)} · ${esc(po.series)} ${esc(po.model_no)} · Qty ${esc(qty)}${po.lot_label ? ` · ${esc(po.lot_label)}` : ""}</div>
    ${t.remarks ? `<div class="t2">💬 ${esc(t.remarks)}</div>` : ""}
    <div class="due">${held ? "Paused" : esc(d.label)}</div>
  </a>`;
}

export async function renderTasks(page) {
  const select = "id,po_number,lot_key,step_code,status,planned_at,actual_at,created_at,attempt_no,remarks," +
    "steps(step_name,step_type),purchase_orders(series,model_no,lot_label,status,total_qty,priority),lots(qty,status,priority)";
  const [pending, done] = await Promise.all([
    q(sb.from("tasks").select(select).eq("doer_email", state.email).eq("status", "PENDING").order("planned_at").limit(1000)),
    q(sb.from("tasks").select(select).eq("doer_email", state.email).eq("status", "DONE").order("actual_at", { ascending: false }).limit(10)),
  ]);

  const info = pending.map((t) => ({ t, d: dueInfo(t) }));
  const counts = {
    all: pending.length,
    overdue: info.filter((x) => x.d.cls === "overdue").length,
    today: info.filter((x) => x.d.cls === "today").length,
    upcoming: info.filter((x) => x.d.cls === "ok" || x.d.cls === "new").length,
  };

  page.innerHTML = `
    <div class="spread"><h1>Namaste, ${esc(state.profile.full_name)}</h1><button class="btn small" id="reload">↻ Refresh</button></div>
    <div class="grid kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="v">${counts.all}</div><div class="l">Pending</div></div>
      <div class="kpi red"><div class="v">${counts.overdue}</div><div class="l">Overdue</div></div>
      <div class="kpi amber"><div class="v">${counts.today}</div><div class="l">Due today</div></div>
      <div class="kpi green"><div class="v">${counts.upcoming}</div><div class="l">On track</div></div>
    </div>
    <div class="chips">
      ${["all", "overdue", "today", "upcoming"].map((f) => `<button class="chip ${filter === f ? "on" : ""}" data-f="${f}">${f[0].toUpperCase() + f.slice(1)} (${counts[f]})</button>`).join("")}
    </div>
    <input id="search" placeholder="Search PO / lot / model…" value="${esc(search)}" style="margin-bottom:12px">
    <div class="tasklist" id="list"></div>
    <h2 style="margin-top:28px">Recently done</h2>
    <div class="tasklist">${done.length ? done.map((t) => `<a class="task" href="#/task/${t.id}" style="border-left-color:var(--border)">
        <div class="t1"><span class="step">${esc(t.step_code)}</span> ${esc(t.steps?.step_name)}</div>
        <div class="t2">${esc(t.lot_key || t.po_number)} · Done ${fmtDT(t.actual_at)}</div></a>`).join("") : `<div class="empty small">Abhi kuch done nahi hua.</div>`}</div>`;

  const draw = () => {
    const s = search.toLowerCase();
    const rows = info.filter(({ t, d }) => {
      if (filter === "overdue" && d.cls !== "overdue") return false;
      if (filter === "today" && d.cls !== "today") return false;
      if (filter === "upcoming" && !(d.cls === "ok" || d.cls === "new")) return false;
      if (!s) return true;
      const po = t.purchase_orders || {};
      return [t.po_number, t.lot_key, po.model_no, po.series, po.lot_label, t.step_code, t.steps?.step_name].join(" ").toLowerCase().includes(s);
    });
    $("#list").innerHTML = rows.length ? rows.map((x) => taskCard(x.t)).join("")
      : `<div class="empty">${pending.length ? "Is filter me koi task nahi." : "🎉 Koi pending task nahi hai."}</div>`;
  };
  draw();

  $$(".chip", page).forEach((b) => b.onclick = () => { filter = b.dataset.f; $$(".chip", page).forEach((c) => c.classList.toggle("on", c === b)); draw(); });
  $("#search").oninput = (e) => { search = e.target.value; draw(); };
  $("#reload").onclick = () => renderTasks(page);
}
