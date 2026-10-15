// Reports: monthly throughput, step TAT, doer performance, overdue trend + CSV exports
import { sb, fetchAll } from "../sb.js";
import { state, userName } from "../state.js";
import { esc, $, monthKey, fmtDT, downloadCSV } from "../ui.js";

let months = 6;

function monthList(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 15);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const hrs = (ms) => Math.round(ms / 36e5);

function bars(rows, key, label, cls = "") {
  const max = Math.max(1, ...rows.map((r) => r[key]));
  return rows.map((r) => `<div class="hbar"><div class="small">${esc(r[label])}</div>
    <div class="b"><div class="${cls}" style="width:${(r[key] / max) * 100}%"></div></div><div class="num small">${r[key]}</div></div>`).join("");
}

function table(cols, rows) {
  return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${esc(c.get(r) ?? "-")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export async function renderReports(page) {
  const mlist = monthList(months);
  const from = new Date(`${mlist[0]}-01T00:00:00+05:30`).toISOString();

  page.innerHTML = `<div class="spread"><h1>Reports</h1>
      <select id="range" style="width:auto">${[3, 6, 12].map((n) => `<option value="${n}" ${n === months ? "selected" : ""}>Last ${n} months</option>`).join("")}</select></div>
    <div id="r"><div class="spinner"></div></div>`;
  $("#range").onchange = (e) => { months = Number(e.target.value); renderReports(page); };

  const [tasks, pos, assigns] = await Promise.all([
    fetchAll(() => sb.from("tasks").select("id,po_number,lot_key,step_code,doer_email,status,planned_at,actual_at,created_at,attempt_no").gte("created_at", from).order("id")),
    fetchAll(() => sb.from("purchase_orders").select("po_number,total_qty,unit_price,created_at,status,completed_at").gte("created_at", from)),
    fetchAll(() => sb.from("client_assignments").select("po_number,qty,client_name,created_at").gte("created_at", from)),
  ]);
  const done = tasks.filter((t) => t.status === "DONE" && t.actual_at);
  const late = (t) => new Date(t.actual_at) > new Date(t.planned_at);

  // monthly throughput
  const monthly = mlist.map((m) => {
    const d = done.filter((t) => monthKey(t.actual_at) === m);
    return {
      month: m,
      pos: pos.filter((p) => monthKey(p.created_at) === m).length,
      po_qty: pos.filter((p) => monthKey(p.created_at) === m).reduce((s, p) => s + p.total_qty, 0),
      po_value: pos.filter((p) => monthKey(p.created_at) === m).reduce((s, p) => s + p.total_qty * (Number(p.unit_price) || 0), 0),
      assigned: assigns.filter((a) => monthKey(a.created_at) === m).reduce((s, a) => s + a.qty, 0),
      tasks_done: d.length,
      late: d.filter(late).length,
      ontime: pct(d.filter((t) => !late(t)).length, d.length),
    };
  });

  // step TAT
  const steps = state.steps.map((s) => {
    const d = done.filter((t) => t.step_code === s.step_code);
    const delays = d.filter(late).map((t) => new Date(t.actual_at) - new Date(t.planned_at));
    return {
      step: `${s.step_code} ${s.step_name}`, tat: s.tat_hours, done: d.length,
      ontime: pct(d.length - delays.length, d.length),
      avg_delay: delays.length ? hrs(delays.reduce((a, b) => a + b, 0) / delays.length) : 0,
      rework: tasks.filter((t) => t.step_code === s.step_code && t.attempt_no > 1).length,
      pending: tasks.filter((t) => t.step_code === s.step_code && t.status === "PENDING").length,
    };
  });

  // doer performance
  const doers = state.users.map((u) => {
    const d = done.filter((t) => t.doer_email === u.email);
    const lateN = d.filter(late).length;
    return {
      name: u.full_name, done: d.length, late: lateN, ontime: pct(d.length - lateN, d.length),
      pending: tasks.filter((t) => t.doer_email === u.email && t.status === "PENDING").length,
      rejected_by: tasks.filter((t) => t.status === "REJECTED" && t.doer_email === u.email).length,
    };
  }).filter((r) => r.done || r.pending);

  const topClients = Object.entries(assigns.reduce((m, a) => ({ ...m, [a.client_name]: (m[a.client_name] || 0) + a.qty }), {}))
    .map(([client, qty]) => ({ client, qty })).sort((a, b) => b.qty - a.qty).slice(0, 10);

  $("#r").innerHTML = `
    <div class="card"><div class="spread"><h2 style="margin:0">Monthly throughput</h2><button class="btn small" id="c1">⬇ CSV</button></div>
      ${table([
        { label: "Month", get: (r) => r.month }, { label: "New POs", num: 1, get: (r) => r.pos }, { label: "PO qty", num: 1, get: (r) => r.po_qty },
        { label: "PO value ₹", num: 1, get: (r) => r.po_value.toLocaleString("en-IN") }, { label: "Qty to clients", num: 1, get: (r) => r.assigned },
        { label: "Tasks done", num: 1, get: (r) => r.tasks_done }, { label: "Late", num: 1, get: (r) => r.late },
        { label: "On-time %", num: 1, get: (r) => (r.ontime == null ? "-" : r.ontime + "%") },
      ], monthly)}
      <h3 style="margin-top:14px">Qty assigned to clients</h3>${bars(monthly, "assigned", "month")}
      <h3 style="margin-top:14px">Overdue trend (tasks finished late)</h3>${bars(monthly, "late", "month", "red")}</div>

    <div class="card"><div class="spread"><h2 style="margin:0">Step TAT / bottlenecks</h2><button class="btn small" id="c2">⬇ CSV</button></div>
      ${table([
        { label: "Step", get: (r) => r.step }, { label: "TAT hrs", num: 1, get: (r) => r.tat }, { label: "Done", num: 1, get: (r) => r.done },
        { label: "On-time %", num: 1, get: (r) => (r.ontime == null ? "-" : r.ontime + "%") }, { label: "Avg delay hrs (late ones)", num: 1, get: (r) => r.avg_delay },
        { label: "Rework", num: 1, get: (r) => r.rework }, { label: "Pending", num: 1, get: (r) => r.pending },
      ], steps)}</div>

    <div class="card"><div class="spread"><h2 style="margin:0">Doer performance</h2><button class="btn small" id="c3">⬇ CSV</button></div>
      ${table([
        { label: "Doer", get: (r) => r.name }, { label: "Done", num: 1, get: (r) => r.done }, { label: "Late", num: 1, get: (r) => r.late },
        { label: "On-time %", num: 1, get: (r) => (r.ontime == null ? "-" : r.ontime + "%") }, { label: "Pending now", num: 1, get: (r) => r.pending },
        { label: "Rejected", num: 1, get: (r) => r.rejected_by },
      ], doers)}</div>

    <div class="card"><h2>Top clients (qty)</h2>${topClients.length ? bars(topClients, "qty", "client") : `<div class="dim">Abhi data nahi.</div>`}</div>

    <div class="card"><h2>Raw export</h2><p class="small dim">Selected range ke saare tasks (planned vs actual).</p>
      <button class="btn" id="c4">⬇ All tasks CSV</button></div>`;

  $("#c1").onclick = () => downloadCSV("omex-monthly.csv", monthly);
  $("#c2").onclick = () => downloadCSV("omex-step-tat.csv", steps);
  $("#c3").onclick = () => downloadCSV("omex-doers.csv", doers);
  $("#c4").onclick = () => downloadCSV("omex-tasks.csv", tasks, [
    { label: "Task", key: "id" }, { label: "PO", key: "po_number" }, { label: "Lot", key: "lot_key" }, { label: "Step", key: "step_code" },
    { label: "Doer", get: (t) => userName(t.doer_email) }, { label: "Status", key: "status" }, { label: "Attempt", key: "attempt_no" },
    { label: "Planned (IST)", get: (t) => fmtDT(t.planned_at) }, { label: "Actual (IST)", get: (t) => (t.actual_at ? fmtDT(t.actual_at) : "") },
    { label: "Delay hrs", get: (t) => (t.actual_at && late(t) ? hrs(new Date(t.actual_at) - new Date(t.planned_at)) : 0) },
  ]);
}
