# Omex FMS — Future Order Flow Management

Replaces the Google Sheet "FUTURE ORDER LOOKER" (FMS, FMS 2–5) with Supabase + a mobile-first website.
Cost: ₹0 (Supabase free, Vercel free, Resend free).

**Setup:** follow [SETUP_GUIDE.md](SETUP_GUIDE.md) (Hinglish, step by step, ~40 min).

## Flow

```
Sales creates PO ─▶ S1 PARTIAL WO (Neha) ── split ──▶ WO lots
WO lot: S2 Material Assessment → S3 Final Indent → S4 PO Release → S5 Material Receive
        → S6 Production WO → S7 Assembly Planning ── split ──▶ BO lots
BO lot: S8 BO Order → S9 BO Received → S10 FG Confirmation ── split ──▶ FG lots
FG lot: S11 Assign to Client ──▶ client assignments (qty per client)
```

* Split steps (S1, S7, S10) and S11 stay **pending until balance = 0** — partial splits allowed.
* **TAT in working hours**: 09:00–17:30 IST, Sunday off, holidays skipped — identical to the sheet's Planned formula
  (verified against sheet values in `supabase/tests/test_flow.sql`).
* Lot keys: `PO/26/08/030-W1`, `…-W1-B2`, `…-W1-B2-F1`. Old sheet "UNIQUE NO." is kept as `legacy_key` (searchable).

## Features

| | |
|---|---|
| Doer dashboard | Own tasks only, colour coded (red overdue / amber today / blue new / green on track), ≤ 3 taps to Mark Done |
| Step forms | Different fields per step, saved as JSON; drafts saved on the phone if the internet drops |
| Edge cases | Reject → previous step reopens (attempt #2); hold / resume (due dates shift by hold time); cancel lot / PO; reassign task or whole step; edit within 1 hour, later with admin approval; duplicate PO blocked with next-number suggestion |
| Notifications | Email via Resend, grouped per person; reminders 12 working hrs before due, at due time, escalation at 12 hrs overdue (CC super admin), morning overdue summary; in-app toast via Supabase Realtime |
| Admin | Overview + bottlenecks, workload, PO/lot tree, settings (TAT, doers, users, holidays, config), edit approvals, audit log, email log |
| Reports | Monthly throughput, step TAT / on-time %, doer performance, overdue trend, top clients, CSV exports |
| Security | Row Level Security: doers see only their tasks; all changes go through checked database functions |

## Files

```
supabase/01_setup.sql            tables, workflow functions, reminders, RLS  (run first)
supabase/02_cron.sql             pg_cron schedule for reminders + email sender
supabase/functions/send-emails/  Edge Function (Resend)
supabase/tests/test_flow.sql     45 workflow tests (local Postgres)
tools/import_sheet.py            Google Sheet .xlsx → history import SQL
web/                             the website (static, no build step)
```

## Run the database tests locally

```bash
createdb fms_test
psql -d fms_test -c "create role anon nologin; create role authenticated nologin;"
psql -d fms_test -f supabase/01_setup.sql
psql -d fms_test -f supabase/tests/test_flow.sql      # ends with: ALL TESTS PASSED
```
