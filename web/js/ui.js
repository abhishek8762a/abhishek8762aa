// Small UI helpers: escaping, formatting, toasts, modals, CSV.

export const TZ = "Asia/Kolkata";

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- dates (always shown in IST) ----------
export function fmtDT(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("en-IN", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}
export function fmtD(d) {
  if (!d) return "-";
  const dt = typeof d === "string" && d.length === 10 ? new Date(d + "T00:00:00+05:30") : new Date(d);
  return dt.toLocaleDateString("en-IN", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" });
}
export function dayKey(ts) {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}
export function monthKey(ts) { return dayKey(ts).slice(0, 7); }
export function todayISO() { return dayKey(Date.now()); }

export function humanDur(ms) {
  const h = Math.abs(ms) / 3600e3;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} hr`;
  return `${Math.round(h / 24)} days`;
}

// Red = overdue, Amber = due today, Blue = new (< 2 hr old), Green = on track
export function dueInfo(task) {
  const now = Date.now();
  const due = new Date(task.planned_at).getTime();
  if (due < now) return { cls: "overdue", label: `${humanDur(now - due)} overdue`, badge: "red" };
  if (dayKey(due) === dayKey(now)) return { cls: "today", label: `Due today ${fmtDT(due).split(", ").pop()}`, badge: "amber" };
  if (task.created_at && now - new Date(task.created_at).getTime() < 2 * 3600e3) return { cls: "new", label: `New · due ${fmtDT(due)}`, badge: "blue" };
  return { cls: "ok", label: `Due ${fmtDT(due)}`, badge: "green" };
}

export function statusBadge(s) {
  const map = { ACTIVE: "blue", PENDING: "amber", DONE: "green", COMPLETED: "green", REJECTED: "red", CANCELLED: "red", ON_HOLD: "" };
  return `<span class="badge ${map[s] ?? ""}">${esc(s)}</span>`;
}

// ---------- toasts ----------
export function toast(msg, type = "ok", { link, ms = 4500 } = {}) {
  const box = document.getElementById("toasts");
  const t = el(`<div class="toast ${type}">${esc(msg)}${link ? ` <a href="${esc(link)}">Open</a>` : ""}</div>`);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
  t.addEventListener("click", () => t.remove());
}
export function toastError(e) { toast(e?.message || String(e), "error", { ms: 8000 }); }

// ---------- modals ----------
export function modal(innerHtml, { onMount } = {}) {
  const root = document.getElementById("modal-root");
  const bg = el(`<div class="modal-bg"><div class="modal" role="dialog">${innerHtml}</div></div>`);
  const close = () => bg.remove();
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  root.appendChild(bg);
  $$("[data-close]", bg).forEach((b) => b.addEventListener("click", close));
  onMount?.(bg.firstElementChild, close);
  return close;
}

export function confirmBox(title, text, { okLabel = "Yes", danger = false } = {}) {
  return new Promise((resolve) => {
    modal(`<h2>${esc(title)}</h2><p class="dim">${esc(text)}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button>
      <button class="btn ${danger ? "danger" : "primary"}" id="ok">${esc(okLabel)}</button></div>`, {
      onMount(m, close) {
        $("#ok", m).onclick = () => { close(); resolve(true); };
        $$("[data-close]", m).forEach((b) => b.addEventListener("click", () => resolve(false)));
      },
    });
  });
}

// Ask for text (reason etc.). Resolves to string or null.
export function promptBox(title, label, { required = true, okLabel = "Submit", danger = false, multiline = true, value = "" } = {}) {
  return new Promise((resolve) => {
    modal(`<h2>${esc(title)}</h2>
      <div class="field"><label class="f ${required ? "req" : ""}">${esc(label)}</label>
      ${multiline ? `<textarea id="pv">${esc(value)}</textarea>` : `<input id="pv" value="${esc(value)}">`}</div>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button>
      <button class="btn ${danger ? "danger" : "primary"}" id="ok">${esc(okLabel)}</button></div>`, {
      onMount(m, close) {
        const inp = $("#pv", m);
        inp.focus();
        $("#ok", m).onclick = () => {
          const v = inp.value.trim();
          if (required && !v) { inp.focus(); return; }
          close(); resolve(v);
        };
        $$("[data-close]", m).forEach((b) => b.addEventListener("click", () => resolve(null)));
      },
    });
  });
}

export function selectBox(title, label, options, { okLabel = "Save" } = {}) {
  return new Promise((resolve) => {
    modal(`<h2>${esc(title)}</h2><div class="field"><label class="f">${esc(label)}</label>
      <select id="pv">${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select></div>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="ok">${esc(okLabel)}</button></div>`, {
      onMount(m, close) {
        $("#ok", m).onclick = () => { const v = $("#pv", m).value; close(); resolve(v); };
        $$("[data-close]", m).forEach((b) => b.addEventListener("click", () => resolve(null)));
      },
    });
  });
}

// ---------- CSV ----------
export function downloadCSV(filename, rows, columns) {
  const cols = columns ?? Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: k }));
  const cell = (v) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => cell(c.label)).join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(typeof c.get === "function" ? c.get(r) : r[c.key])).join(","));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- local drafts (offline tolerance) ----------
export const drafts = {
  get(key) { try { return JSON.parse(localStorage.getItem("fms-draft-" + key) || "null"); } catch { return null; } },
  set(key, v) { try { localStorage.setItem("fms-draft-" + key, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  clear(key) { try { localStorage.removeItem("fms-draft-" + key); } catch { /* ignore */ } },
};

export function busy(btn, on, text) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = text || "Saving…"; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}
