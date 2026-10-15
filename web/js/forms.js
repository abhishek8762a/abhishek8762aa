// Step-specific form fields (saved as JSON in tasks.data).
// All fields are optional so "Mark Done" stays quick — only split / assign qty is required.
import { esc, $, $$, el } from "./ui.js";

const ATTACH = { k: "attachments", type: "file", label: "Attachment (PDF / photo)" };

export const STEP_FORMS = {
  S1: {
    hint: "PO ko work-order lots me todein. Balance 0 hone tak ye task pending rahega.",
    fields: [],
    split: { title: "Work order lots", needDate: true, showPriority: true },
  },
  S2: {
    fields: [
      { k: "materials", type: "rows", label: "Material list", cols: [
        { k: "item", label: "Item" },
        { k: "qty_needed", label: "Qty needed", type: "number" },
        { k: "qty_available", label: "Qty available", type: "number" },
        { k: "status", label: "Status", type: "select", options: ["Available", "Short", "Not Available"] },
      ] },
      { k: "can_proceed", type: "select", label: "Can proceed?", options: ["Yes", "No"], hint: "No ho to remarks me likhein — Super Admin lot hold kar dega." },
    ],
  },
  S3: {
    fields: [
      { k: "indent_items", type: "rows", label: "Indent items", total: { col: "amount", label: "Total indent value ₹" }, cols: [
        { k: "item_code", label: "Item code" },
        { k: "description", label: "Description" },
        { k: "qty", label: "Qty", type: "number" },
        { k: "rate", label: "Est. rate ₹", type: "number" },
        { k: "vendor", label: "Preferred vendor" },
      ] },
      { k: "approval_required", type: "select", label: "Approval required?", options: ["No", "Yes"] },
      ATTACH,
    ],
  },
  S4: {
    hint: "Ek lot ke liye kitne bhi vendor PO add kar sakte hain.",
    fields: [
      { k: "vendor_pos", type: "rows", label: "Vendor POs", cols: [
        { k: "po_no", label: "Vendor PO no." },
        { k: "vendor", label: "Vendor" },
        { k: "po_date", label: "PO date", type: "date" },
        { k: "value", label: "Value ₹", type: "number" },
        { k: "expected", label: "Expected delivery", type: "date" },
      ] },
      ATTACH,
    ],
  },
  S5: {
    fields: [
      { k: "grn_no", label: "GRN number" },
      { k: "receipt_date", label: "Receipt date", type: "date" },
      { k: "items", type: "rows", label: "Items received", cols: [
        { k: "item", label: "Item" },
        { k: "qty_expected", label: "Qty expected", type: "number" },
        { k: "qty_received", label: "Qty received", type: "number" },
        { k: "quality", label: "Quality", type: "select", options: ["OK", "NOT OK"] },
      ] },
      { k: "partial", type: "select", label: "Partial receipt?", options: ["No", "Yes"] },
      { k: "shortage", type: "textarea", label: "Shortage report" },
    ],
  },
  S6: {
    fields: [
      { k: "production_wo_no", label: "Production WO number" },
      { k: "supervisor", label: "Shop floor supervisor" },
      { k: "expected_completion", label: "Expected completion", type: "date" },
      { k: "line_machine", label: "Line / machine" },
    ],
  },
  S7: {
    hint: "Assembly plan bharein aur qty BO stage me bhejein (ek saath ya hisson me).",
    fields: [
      { k: "assembly_date", label: "Assembly date", type: "date" },
      { k: "assembly_line", label: "Assembly line" },
      { k: "operator", label: "Operator" },
      { k: "qc_inspector", label: "QC inspector" },
      { k: "bo_items", type: "rows", label: "BO items required", cols: [
        { k: "item", label: "Item" },
        { k: "qty", label: "Qty", type: "number" },
      ] },
      { k: "bom_ref", label: "BOM reference" },
    ],
    split: { title: "Qty to BO stage", needDate: false, showPriority: false },
  },
  S8: {
    fields: [
      { k: "bo_orders", type: "rows", label: "BO items ordered", total: { col: "amount", label: "Total BO value ₹" }, cols: [
        { k: "item", label: "Item" },
        { k: "vendor", label: "Vendor" },
        { k: "qty", label: "Qty", type: "number" },
        { k: "rate", label: "Rate ₹", type: "number" },
        { k: "expected", label: "Expected", type: "date" },
      ] },
      ATTACH,
    ],
  },
  S9: {
    fields: [
      { k: "grn_nos", label: "GRN number(s)" },
      { k: "received_date", label: "Received date", type: "date" },
      { k: "items", type: "rows", label: "Items received", cols: [
        { k: "item", label: "Item" },
        { k: "qty_ordered", label: "Qty ordered", type: "number" },
        { k: "qty_received", label: "Qty received", type: "number" },
      ] },
      { k: "issues", type: "textarea", label: "Shortage / quality issues" },
    ],
  },
  S10: {
    hint: "Jitni qty ready hai utni FG lot banayein. Baaki baad me — balance 0 hone tak task pending rahega.",
    fields: [
      { k: "serial_numbers", type: "textarea", label: "Serial numbers" },
      { k: "qc", type: "select", label: "QC", options: ["Pass", "Fail"] },
      { k: "location", label: "FG storage location" },
      { k: "packing", type: "select", label: "Packing status", options: ["Packed", "Not packed"] },
    ],
    split: { title: "Ready qty (FG lots)", needDate: false, showPriority: false },
  },
  S11: {
    hint: "Ready qty clients ko assign karein. Balance 0 hone tak task pending rahega.",
    fields: [ATTACH],
    assign: true,
  },
};

export const fieldsFor = (code) => STEP_FORMS[code]?.fields ?? [];

// label lookup for showing saved data
export function labelFor(code, key) {
  const f = fieldsFor(code).find((x) => x.k === key);
  return f?.label ?? key.replace(/_/g, " ");
}

// ---------- rendering ----------
function inputHtml(f, value, name) {
  const v = value ?? "";
  if (f.type === "select") {
    return `<select name="${name}"><option value=""></option>${f.options.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  }
  if (f.type === "textarea") return `<textarea name="${name}">${esc(v)}</textarea>`;
  const type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
  return `<input type="${type}" name="${name}" value="${esc(v)}" ${type === "number" ? 'inputmode="decimal" step="any"' : ""}>`;
}

function rowHtml(f, row = {}) {
  return `<tr>${f.cols.map((c) => `<td>${inputHtml(c, row[c.k], c.k)}</td>`).join("")}
    <td><button type="button" class="btn ghost small" data-del title="Remove">✕</button></td></tr>`;
}

export function renderFields(code, data = {}) {
  return fieldsFor(code).map((f) => {
    if (f.type === "rows") {
      const rows = Array.isArray(data[f.k]) && data[f.k].length ? data[f.k] : [{}];
      return `<div class="field" data-rows="${f.k}"><label class="f">${esc(f.label)}</label>
        <div class="table-wrap"><table class="rows-table"><thead><tr>${f.cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}<th></th></tr></thead>
        <tbody>${rows.map((r) => rowHtml(f, r)).join("")}</tbody></table></div>
        <div class="spread" style="margin-top:6px"><button type="button" class="btn small" data-add>+ Add row</button>
        ${f.total ? `<span class="small dim">${esc(f.total.label)}: <b data-total>0</b></span>` : ""}</div></div>`;
    }
    if (f.type === "file") {
      const files = Array.isArray(data[f.k]) ? data[f.k] : [];
      return `<div class="field" data-file="${f.k}"><label class="f">${esc(f.label)}</label>
        <input type="file" accept="application/pdf,image/*" multiple>
        <div class="small dim" data-existing>${files.map((x) => esc(x.name)).join(", ")}</div></div>`;
    }
    return `<div class="field"><label class="f">${esc(f.label)}</label>${inputHtml(f, data[f.k], f.k)}
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}</div>`;
  }).join("");
}

// Wire add/remove row buttons + totals inside a container
export function wireFields(code, root, onChange) {
  for (const f of fieldsFor(code)) {
    if (f.type !== "rows") continue;
    const box = $(`[data-rows="${f.k}"]`, root);
    if (!box) continue;
    const tbody = $("tbody", box);
    const recalc = () => {
      if (!f.total) return;
      let sum = 0;
      for (const tr of $$("tr", tbody)) {
        const qty = Number($('[name="qty"]', tr)?.value || 0);
        const rate = Number($('[name="rate"]', tr)?.value || 0);
        sum += qty * rate;
      }
      $("[data-total]", box).textContent = sum.toLocaleString("en-IN");
    };
    $("[data-add]", box).onclick = () => { tbody.appendChild(el(`<table><tbody>${rowHtml(f)}</tbody></table>`).querySelector("tr")); onChange?.(); };
    tbody.addEventListener("click", (e) => {
      if (e.target.closest("[data-del]")) { e.target.closest("tr").remove(); recalc(); onChange?.(); }
    });
    tbody.addEventListener("input", recalc);
    recalc();
  }
}

// Read values back into an object (empty rows skipped)
export function collectFields(code, root, existing = {}) {
  const out = {};
  for (const f of fieldsFor(code)) {
    if (f.type === "rows") {
      const rows = [];
      for (const tr of $$(`[data-rows="${f.k}"] tbody tr`, root)) {
        const r = {};
        for (const c of f.cols) {
          const v = $(`[name="${c.k}"]`, tr)?.value?.trim() ?? "";
          if (v !== "") r[c.k] = c.type === "number" ? Number(v) : v;
        }
        if (Object.keys(r).length) {
          if (f.total && r.qty != null && r.rate != null) r.amount = r.qty * r.rate;
          rows.push(r);
        }
      }
      if (rows.length) out[f.k] = rows;
      if (f.total && rows.length) out[f.total.col === "amount" ? f.k + "_total" : f.total.col] = rows.reduce((s, r) => s + (r.amount || 0), 0);
    } else if (f.type === "file") {
      if (Array.isArray(existing[f.k]) && existing[f.k].length) out[f.k] = existing[f.k];
    } else {
      const v = $(`[name="${f.k}"]`, root)?.value?.trim() ?? "";
      if (v !== "") out[f.k] = f.type === "number" ? Number(v) : v;
    }
  }
  return out;
}

// Files picked in the form (uploaded on submit)
export function pickedFiles(code, root) {
  const f = fieldsFor(code).find((x) => x.type === "file");
  if (!f) return [];
  const input = $(`[data-file="${f.k}"] input[type=file]`, root);
  return input ? [...input.files] : [];
}

// ---------- read-only view of saved data ----------
export function renderData(code, data) {
  if (!data || typeof data !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "batches" || v == null || v === "") continue;
    if (k === "attachments" && Array.isArray(v)) {
      parts.push(`<div>${esc(labelFor(code, k))}</div><div>${v.map((a) => `<a href="#" data-file-path="${esc(a.path)}">${esc(a.name)}</a>`).join(", ")}</div>`);
    } else if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      const f = fieldsFor(code).find((x) => x.k === k);
      const cols = f?.cols?.map((c) => c.k) ?? Object.keys(v[0]);
      if (v.some((r) => r.amount != null) && !cols.includes("amount")) cols.push("amount");
      const head = cols.map((c) => f?.cols?.find((x) => x.k === c)?.label ?? c).map(esc);
      parts.push(`<div>${esc(labelFor(code, k))}</div><div><div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${v.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`);
    } else {
      parts.push(`<div>${esc(labelFor(code, k))}</div><div>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</div>`);
    }
  }
  const batches = Array.isArray(data.batches) ? data.batches : [];
  if (batches.length) {
    const lots = batches.flatMap((b) => (b.lots || []).map((l) => `${l.lot_key} (${l.qty})`));
    parts.push(`<div>Lots created</div><div>${esc(lots.join(", "))}</div>`);
  }
  return parts.length ? `<div class="kv">${parts.join("")}</div>` : "";
}
