import { sb, configured, q } from "./sb.js";
import { state, isAdmin, isSales } from "./state.js";
import { esc, toast, $, el } from "./ui.js";
import { renderTasks } from "./pages/tasks.js";
import { renderTask } from "./pages/task.js";
import { renderNewPO } from "./pages/newpo.js";
import { renderPOs } from "./pages/pos.js";
import { renderAdmin } from "./pages/admin.js";
import { renderReports } from "./pages/reports.js";

const app = document.getElementById("app");
let realtime = null;

// ---------- offline banner ----------
const offline = document.getElementById("offline");
const setOnline = () => offline.classList.toggle("hidden", navigator.onLine);
window.addEventListener("online", setOnline);
window.addEventListener("offline", setOnline);
setOnline();

// ---------- login screen ----------
function renderLogin(message = "") {
  app.innerHTML = `
    <div class="login">
      <div class="logo">Omex <span>FMS</span></div>
      <p class="dim" style="text-align:center;margin-top:0">Future Order Flow Management</p>
      <form class="card" id="login-form">
        ${message ? `<div class="banner red">${esc(message)}</div>` : ""}
        <div class="field"><label class="f">Email</label><input type="email" id="email" autocomplete="username" required placeholder="dp6@omexgears.com"></div>
        <div class="field"><label class="f">Password</label><input type="password" id="password" autocomplete="current-password" required></div>
        <button class="btn primary block big" id="go">Login</button>
        <button type="button" class="btn ghost block" id="forgot" style="margin-top:8px">Password bhool gaye?</button>
      </form>
    </div>`;
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#go");
    btn.disabled = true;
    btn.textContent = "Logging in…";
    const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim().toLowerCase(), password: $("#password").value });
    if (error) {
      btn.disabled = false;
      btn.textContent = "Login";
      toast(error.message === "Invalid login credentials" ? "Email ya password galat hai" : error.message, "error");
    }
  };
  $("#forgot").onclick = async () => {
    const email = $("#email").value.trim().toLowerCase();
    if (!email) return toast("Pehle email likhein", "error");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    toast(error ? error.message : "Password reset link email par bhej diya", error ? "error" : "ok");
  };
}

function renderSetPassword() {
  app.innerHTML = `
    <div class="login"><div class="logo">Omex <span>FMS</span></div>
      <form class="card" id="pw-form"><h2>Naya password</h2>
        <div class="field"><label class="f">New password (min 8)</label><input type="password" id="pw" minlength="8" required></div>
        <button class="btn primary block big">Save password</button></form></div>`;
  $("#pw-form").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: $("#pw").value });
    if (error) return toast(error.message, "error");
    toast("Password update ho gaya");
    location.hash = "#/tasks";
    boot();
  };
}

function renderNotConfigured() {
  app.innerHTML = `<div class="login"><div class="logo">Omex <span>FMS</span></div>
    <div class="card"><h2>Setup baaki hai</h2><p><code>web/config.js</code> me Supabase URL aur anon key daalein (SETUP_GUIDE.md, step 4).</p></div></div>`;
}

// ---------- shell ----------
function navLinks() {
  const links = [{ href: "#/tasks", label: "My Tasks", id: "nav-tasks" }];
  if (isSales()) links.push({ href: "#/new-po", label: "+ New PO" }, { href: "#/pos", label: "POs" });
  if (isAdmin()) links.push({ href: "#/admin", label: "Admin" }, { href: "#/reports", label: "Reports" });
  return links;
}

function renderShell() {
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/tasks">Omex <span>FMS</span></a>
      <nav class="nav">${navLinks().map((l) => `<a href="${l.href}" ${l.id ? `id="${l.id}"` : ""}>${esc(l.label)}</a>`).join("")}</nav>
      <button class="btn ghost small" id="theme" title="Light / dark">Theme</button>
      <button class="btn ghost small" id="logout" title="${esc(state.email)}">Logout</button>
    </header>
    <main class="main" id="page"></main>`;
  $("#logout").onclick = async () => { await sb.auth.signOut(); };
  $("#theme").onclick = () => {
    const light = document.documentElement.dataset.theme !== "light";
    document.documentElement.dataset.theme = light ? "light" : "";
    try { localStorage.setItem("fms-theme", light ? "light" : "dark"); } catch { /* ignore */ }
  };
  updateBadge();
}

function setActiveNav() {
  const h = location.hash || "#/tasks";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", h.startsWith(a.getAttribute("href"))));
}

export async function updateBadge() {
  if (!state.email) return;
  const { count } = await sb.from("tasks").select("id", { count: "exact", head: true })
    .eq("doer_email", state.email).eq("status", "PENDING");
  state.pendingCount = count ?? 0;
  const a = document.getElementById("nav-tasks");
  if (a) a.innerHTML = `My Tasks ${state.pendingCount ? `<span class="count">${state.pendingCount}</span>` : ""}`;
  document.title = (state.pendingCount ? `(${state.pendingCount}) ` : "") + "Omex FMS";
}

// ---------- router ----------
async function route() {
  if (!state.profile) return;
  const page = document.getElementById("page");
  if (!page) return;
  setActiveNav();
  const [, name, arg] = (location.hash || "#/tasks").split("/");
  page.innerHTML = `<div class="spinner"></div>`;
  try {
    if (name === "task" && arg) await renderTask(page, Number(arg));
    else if (name === "new-po" && isSales()) await renderNewPO(page);
    else if (name === "pos" && isSales()) await renderPOs(page);
    else if (name === "admin" && isAdmin()) await renderAdmin(page, arg);
    else if (name === "reports" && isAdmin()) await renderReports(page);
    else await renderTasks(page);
  } catch (e) {
    page.innerHTML = `<div class="banner red">${esc(e.message || e)}</div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
export const refresh = route;

// ---------- realtime toast for new / reassigned tasks ----------
function startRealtime() {
  if (realtime) sb.removeChannel(realtime);
  realtime = sb.channel("my-tasks")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `doer_email=eq.${state.email}` }, (payload) => {
      const t = payload.new;
      if (t?.status === "PENDING" && (payload.eventType === "INSERT" || payload.old?.doer_email !== state.email)) {
        toast(`Naya task: ${t.step_code} — ${t.lot_key || t.po_number}`, "info", { link: `#/task/${t.id}`, ms: 9000 });
        if ((location.hash || "#/tasks").startsWith("#/tasks")) route();
      }
      updateBadge();
    })
    .subscribe();
}

// ---------- boot ----------
async function loadProfile() {
  state.email = state.session.user.email.toLowerCase();
  const [profile, steps, users] = await Promise.all([
    q(sb.from("app_users").select("*").eq("email", state.email).maybeSingle()),
    q(sb.from("steps").select("*").order("step_order")),
    q(sb.from("app_users").select("*").order("full_name")),
  ]);
  state.steps = steps;
  state.users = users;
  state.profile = profile;
}

let booting = false;
async function boot() {
  if (booting) return;
  booting = true;
  try { await bootInner(); } finally { booting = false; }
}

async function bootInner() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (!state.session) { state.profile = null; return renderLogin(); }
  try {
    await loadProfile();
  } catch (e) {
    return renderLogin(e.message);
  }
  if (!state.profile || !state.profile.is_active) {
    const email = state.email;
    await sb.auth.signOut();
    return renderLogin(`${email} FMS users list me nahi hai. Super Admin se add karwayein.`);
  }
  renderShell();
  startRealtime();
  await route();
}

if (!configured) {
  renderNotConfigured();
} else {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") return renderSetPassword();
    if (event === "SIGNED_OUT") { state.session = null; state.profile = null; state.email = null; if (realtime) sb.removeChannel(realtime); renderLogin(); return; }
    if (event === "SIGNED_IN" && !state.profile) { state.session = session; setTimeout(boot, 0); return; }
    if (event === "TOKEN_REFRESHED") state.session = session;
  });
  boot();
}

// Exposed so pages can rebuild the nav after settings changes
export function reloadShell() { renderShell(); route(); }
export { el };
