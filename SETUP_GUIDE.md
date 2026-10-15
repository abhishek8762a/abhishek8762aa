# Omex FMS — Setup Guide (ek baar, ~40 min)

Aapko 3 free accounts chahiye: **supabase.com**, **vercel.com**, **resend.com**.
Code GitHub repo me ready hai — aapko sirf clicks + copy-paste karna hai.

> ⚠️ Ye GitHub repo abhi **public** hai. GitHub → repo → Settings → General → "Change visibility" → **Private** kar dein.
> Vercel private repo ke saath bhi chalta hai.

---

## Step 1 — Supabase project (5 min)

1. supabase.com → Sign in → **New project**
2. Name: `omex-fms` · Region: **South Asia (Mumbai)** · Database password: strong password likh ke safe rakhein
3. Project ban jane ka wait karein (~2 min)

## Step 2 — Database setup (3 min)

1. Left menu → **SQL Editor** → **New query**
2. GitHub se `supabase/01_setup.sql` ka poora content copy → paste → **Run**
3. Neeche "Success. No rows returned" aana chahiye.

Check: **Table Editor** me `tasks`, `lots`, `purchase_orders`, `steps` (11 rows) dikhne chahiye.

## Step 3 — Users (5 min)

1. **Authentication → Users → Add user → Create new user**
2. Har person ke liye email + password daalein, **"Auto Confirm User" ✓** rakhein:

| Name | Email | Role |
|---|---|---|
| Abhi | dp9@omexgears.com | Super Admin |
| Neha | dp6@omexgears.com | Sales Admin + doer (S1, S7, S11) |
| Aastha | dp2@omexgears.com | Doer (S2, S3, S4, S8) |
| Rajinder | dp10@omexgears.com | Doer (S5, S6, S9, S10) |

(Ye 4 log `app_users` table me pehle se hain. Naya person: pehle website → Admin → Settings → Users me add karein, phir yahan login banayein.)

3. **Authentication → URL Configuration → Site URL** = aapki Vercel website ka link (Step 4 ke baad daalein) — password reset email isi link par le jayega.

## Step 4 — Website live karein (Vercel, 5 min)

1. GitHub repo me `web/config.js` kholein → ✏️ Edit:
   * `SUPABASE_URL` = Supabase → **Project Settings → API → Project URL**
   * `SUPABASE_ANON_KEY` = same page → **anon public** key
   * Commit changes (main branch par)
2. vercel.com → **Add New → Project** → GitHub repo `abhishek8762aa` import karein
3. Framework: **Other** · Root directory: repo root chhod dein (`vercel.json` khud `web/` folder use karta hai) → **Deploy**
4. Link milega jaise `https://abhishek8762aa.vercel.app` → login karke check karein.
   * Agar blank page aaye: Vercel → Project → Settings → Build and Deployment → **Root Directory = `web`** → Redeploy.
5. Abhi ke login se website → **Admin → Settings → Config** → `app_url` = ye Vercel link → Save (email ke "Open task" button ke liye).

Ab website kaam kar rahi hai. Emails ke liye Step 5.

## Step 5 — Email notifications (Resend, 15 min)

**5a. Resend**
1. resend.com → sign up → **Domains → Add domain** → `omexgears.com`
2. Resend jo 2–3 DNS records (TXT / MX) dikhaye, unhe omexgears.com ke DNS (GoDaddy / jahan domain hai) me add karwayein → Verify.
   (Jab tak verify nahi hota, Resend sirf aapke apne email par test mail bhejega.)
3. **API Keys → Create API key** → copy

**5b. Edge Function**
1. Supabase → **Edge Functions → Deploy a new function → Via Editor**
2. Name: `send-emails` · GitHub se `supabase/functions/send-emails/index.ts` ka content paste → **Deploy**
3. Function kholein → **Details** → **"Verify JWT with legacy secret" / "Enforce JWT verification" OFF** karein → Save
   (function apna alag secret check karta hai)
4. **Edge Functions → Secrets** me add karein:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | Resend wali key |
| `MAIL_FROM` | `Omex FMS <fms@omexgears.com>` |
| `CRON_SECRET` | koi bhi lamba random text, jaise `omex-fms-8f3k29dk1l2m` |

**5c. Schedule**
1. SQL Editor → New query → `supabase/02_cron.sql` paste karein
2. Do jagah `<<< CHANGE >>>` badlein:
   * `YOUR-PROJECT-REF` → aapke Project URL wala code (jaise `abcdxyz123`)
   * `CHANGE-ME-to-a-long-random-text` → wahi `CRON_SECRET`
3. **Run**

Check: website → Admin → **Emails** tab. Naya PO banayein → 1–2 min me "Sent" dikhna chahiye.

## Step 6 — Purana data (Google Sheet) import (5 min)

`03_import_history.sql` aapko alag se diya gaya hai (GitHub par nahi hai — usme client naam aur prices hain).
1. SQL Editor → New query → poori file paste → **Run** (sirf ek baar)
2. File ke end me "Data warnings" list hai — sheet ki galat entries (text in qty, double entries). Inhe website par admin se theek kar sakte hain.

Naya sheet export karna ho to: Google Sheet → File → Download → .xlsx, phir
`python tools/import_sheet.py FUTURE_ORDER_LOOKER.xlsx supabase/03_import_history.sql`

## Step 7 — Pilot (1 week)

* Next 10 orders dono jagah (Sheet + website) daalein, compare karein.
* Har doer ko 15 min training: login → My Tasks → task kholo → bharo → **Mark Done**.
* Phone par website kholke **"Add to Home screen"** karein — app jaisa chalega.
* Holidays: Admin → Settings → Holidays (Diwali etc.) — TAT inko skip karega.

---

## Roz ke kaam — kaun kya karega

| Kaun | Kahan | Kya |
|---|---|---|
| Neha | **+ New PO** | Naya PO → S1 task khud ban jata hai |
| Neha | My Tasks → S1 / S7 | Qty ko lots me todna (balance 0 tak task khula rahega) |
| Rajinder | My Tasks → S10 | Jitni FG ready hai utni lot banana |
| Neha | My Tasks → S11 | Ready qty clients ko assign (client, qty, invoice) |
| Koi bhi doer | Task → **Reject** | Pichhla step galat ho to wapas bhejna (reason ke saath) |
| Abhi | Admin / POs / Reports | Hold, resume, cancel, reassign, TAT/doer badalna, reports, CSV |

## Kuch galat ho to

| Problem | Hal |
|---|---|
| Login ke baad "users list me nahi hai" | Admin → Settings → Users me email add karein (bilkul same spelling) |
| Emails nahi ja rahe | Admin → Emails tab me error dekhein; SQL: `select * from cron.job_run_details order by start_time desc limit 5;` |
| Galat TAT | Admin → Settings → Steps → TAT hrs badlein (naye tasks par lagega) |
| Koi on leave | Admin → Settings → Steps → doer badlein → "pending bhi move karo" |
