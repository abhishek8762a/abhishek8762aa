// OMEX FMS — sends queued notifications by email (Resend).
// Called every minute by pg_cron (02_cron.sql). Groups all pending
// notifications of one person into ONE email, so the free 100/day
// Resend limit is enough even when many tasks are created together.
//
// Secrets (Edge Functions → Secrets):
//   RESEND_API_KEY  — from resend.com → API Keys
//   MAIL_FROM       — e.g. "Omex FMS <fms@omexgears.com>" (domain must be verified in Resend)
//   CRON_SECRET     — same text as private_config.cron_secret
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

type Notification = {
  id: number;
  task_id: number | null;
  recipient_email: string;
  cc_email: string | null;
  kind: string;
  subject: string;
  body: string;
  attempts: number;
};

const KIND_LABEL: Record<string, string> = {
  NEW_TASK: "New task",
  DUE_SOON: "Due soon",
  DUE_NOW: "Due now",
  ESCALATION: "Overdue — escalation",
  DIGEST: "Overdue summary",
  INFO: "Info",
};

const KIND_COLOR: Record<string, string> = {
  NEW_TASK: "#2f81f7",
  DUE_SOON: "#d29922",
  DUE_NOW: "#d29922",
  ESCALATION: "#f85149",
  DIGEST: "#f85149",
  INFO: "#8b949e",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function istMidnightUtc(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 3600 * 1000).toISOString();
}

function buildEmail(name: string, items: Notification[], appUrl: string) {
  const subject = items.length === 1
    ? items[0].subject
    : `[Omex FMS] ${items.length} updates — ${[...new Set(items.map((i) => KIND_LABEL[i.kind] ?? i.kind))].join(", ")}`;

  const cards = items.map((n) => {
    const link = n.task_id ? `${appUrl}/#/task/${n.task_id}` : `${appUrl}/#/tasks`;
    const color = KIND_COLOR[n.kind] ?? "#8b949e";
    return `
      <div style="border:1px solid #d0d7de;border-left:4px solid ${color};border-radius:8px;padding:12px 14px;margin:0 0 12px">
        <div style="font-size:12px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.04em">${esc(KIND_LABEL[n.kind] ?? n.kind)}</div>
        <div style="font-weight:600;margin:4px 0 6px">${esc(n.subject.replace(/^\[Omex FMS\]\s*/, ""))}</div>
        <div style="white-space:pre-wrap;font-size:14px;color:#24292f">${esc(n.body)}</div>
        <a href="${link}" style="display:inline-block;margin-top:10px;padding:8px 14px;background:#1f883d;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Open task</a>
      </div>`;
  }).join("");

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#24292f">
      <p>Hi ${esc(name)},</p>
      <p>${items.length === 1 ? "Aapke liye ek update hai:" : `Aapke liye ${items.length} updates hain:`}</p>
      ${cards}
      <p style="color:#57606a;font-size:12px">Omex FMS Bot · <a href="${appUrl}">${appUrl}</a></p>
    </div>`;

  const text = `Hi ${name},\n\n` + items.map((n) =>
    `${n.subject}\n${n.body}\n${n.task_id ? `${appUrl}/#/task/${n.task_id}` : appUrl}\n`
  ).join("\n") + "\nOmex FMS Bot";

  return { subject, html, text };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const mailFrom = Deno.env.get("MAIL_FROM") ?? "Omex FMS <onboarding@resend.dev>";
  if (!resendKey) return new Response("RESEND_API_KEY missing", { status: 500 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: cfgRows } = await db.from("app_config").select("key,value").in("key", ["app_url", "daily_email_limit"]);
  const cfg = Object.fromEntries((cfgRows ?? []).map((r) => [r.key, r.value]));
  const appUrl = (cfg.app_url ?? "").replace(/\/$/, "");
  const dailyLimit = Number(cfg.daily_email_limit ?? 95);

  // Every email marks all its rows with the same sent_at, so distinct sent_at = emails sent today
  const { data: sentRows } = await db.from("notifications")
    .select("sent_at").eq("status", "SENT").gte("sent_at", istMidnightUtc()).limit(5000);
  const sentToday = new Set((sentRows ?? []).map((r) => r.sent_at)).size;
  let budget = dailyLimit - sentToday;
  if (budget <= 0) return Response.json({ skipped: "daily limit reached" });

  const { data: pending, error } = await db.from("notifications")
    .select("id,task_id,recipient_email,cc_email,kind,subject,body,attempts")
    .eq("status", "PENDING").order("id").limit(500);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const { data: users } = await db.from("app_users").select("email,full_name,is_active");
  const userMap = new Map((users ?? []).map((u) => [u.email, u]));

  // one email per (recipient, cc)
  const groups = new Map<string, Notification[]>();
  for (const n of (pending ?? []) as Notification[]) {
    const key = `${n.recipient_email}|${n.cc_email ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  let sent = 0, failed = 0, skipped = 0;
  for (const [key, items] of groups) {
    const [to, cc] = key.split("|");
    const ids = items.map((i) => i.id);
    const user = userMap.get(to);
    if (!user || !user.is_active) {
      await db.from("notifications").update({ status: "SKIPPED", error: "inactive or unknown user" }).in("id", ids);
      skipped += ids.length;
      continue;
    }
    if (budget <= 0) break;

    const mail = buildEmail(user.full_name, items, appUrl);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: mailFrom, to: [to], cc: cc ? [cc] : undefined, ...mail }),
    });

    if (res.ok) {
      await db.from("notifications").update({ status: "SENT", sent_at: new Date().toISOString(), error: null }).in("id", ids);
      sent += ids.length;
      budget -= 1;
    } else {
      const errText = (await res.text()).slice(0, 500);
      for (const n of items) {
        const attempts = n.attempts + 1;
        await db.from("notifications").update({
          attempts,
          error: errText,
          status: attempts >= 5 ? "FAILED" : "PENDING",
        }).eq("id", n.id);
      }
      failed += ids.length;
    }
  }

  return Response.json({ sent, failed, skipped, emails_left_today: budget });
});
