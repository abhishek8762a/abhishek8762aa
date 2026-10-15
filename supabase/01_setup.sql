-- =====================================================================
--  OMEX FMS — Supabase database setup
--  Run this ONCE in Supabase → SQL Editor → New query → paste → Run.
--  Safe to re-run: tables use IF NOT EXISTS, functions are replaced,
--  seed rows use ON CONFLICT DO NOTHING.
--
--  Flow (same as the Google Sheet):
--    PO ──S1 split──▶ WO lots (S2..S7) ──S7 split──▶ BO lots (S8..S10)
--       ──S10 split──▶ FG lots (S11) ──S11──▶ client assignments
--  TAT is counted in WORKING hours (09:00–17:30 IST, Sunday off,
--  dates in `holidays` skipped) — exactly like the sheet's Planned formula.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CONFIG + HOLIDAYS
-- ---------------------------------------------------------------------
create table if not exists app_config (
    key         text primary key,
    value       text not null,
    description text
);

insert into app_config (key, value, description) values
    ('open_time',          '09:00',            'Office opening time (IST)'),
    ('close_time',         '17:30',            'Office closing time (IST)'),
    ('working_days',       '0000001',          'Mon..Sun, 0 = working, 1 = off (same as sheet Config!A3)'),
    ('timezone',           'Asia/Kolkata',     'Timezone for TAT calculation'),
    ('app_url',            'https://omex-fms.vercel.app', 'Website link used in emails'),
    ('escalation_cc',      'dp9@omexgears.com','CC on 12-hour overdue escalation'),
    ('edit_window_minutes','60',               'Doer can edit submitted data for this many minutes'),
    ('due_soon_hours',     '12',               'First reminder: this many working hours before due'),
    ('escalate_after_hours','12',              'Escalation: this many working hours after due'),
    ('digest_time',        '09:30',            'Morning overdue summary email time (IST)'),
    ('daily_email_limit',  '95',               'Stop sending after this many emails per day (Resend free = 100)')
on conflict (key) do nothing;

create table if not exists holidays (
    holiday_date date primary key,
    description  text
);

-- ---------------------------------------------------------------------
-- 2. USERS + STEPS
-- ---------------------------------------------------------------------
create table if not exists app_users (
    email      text primary key check (email = lower(email)),
    full_name  text not null,
    phone      text,
    role       text not null default 'DOER' check (role in ('ADMIN', 'SALES', 'DOER')),
    is_active  boolean not null default true,
    created_at timestamptz not null default now()
);

insert into app_users (email, full_name, role) values
    ('dp9@omexgears.com',  'ABHI',     'ADMIN'),
    ('dp6@omexgears.com',  'NEHA',     'SALES'),
    ('dp2@omexgears.com',  'AASTHA',   'DOER'),
    ('dp10@omexgears.com', 'RAJINDER', 'DOER')
on conflict (email) do nothing;

-- step_type: NORMAL = fill form + Mark Done
--            SPLIT  = create child lots; stays PENDING until balance = 0
--            ASSIGN = assign qty to clients; stays PENDING until balance = 0
create table if not exists steps (
    step_code        text primary key,
    step_name        text not null,
    step_order       int  not null unique,
    stage            text not null check (stage in ('PO', 'WO', 'BO', 'FG')),
    step_type        text not null default 'NORMAL' check (step_type in ('NORMAL', 'SPLIT', 'ASSIGN')),
    next_step_code   text references steps(step_code),
    child_stage      text check (child_stage in ('WO', 'BO', 'FG')),
    child_first_step text references steps(step_code),
    tat_hours        numeric not null check (tat_hours > 0),
    doer_email       text not null references app_users(email),
    description      text,
    updated_at       timestamptz not null default now()
);

-- TAT values copied from row 5 ("When") of FMS / FMS 2 / FMS 3 / FMS 4
insert into steps (step_code, step_name, step_order, stage, step_type, next_step_code, child_stage, child_first_step, tat_hours, doer_email, description) values
    ('S1',  'PARTIAL WO',            1,  'PO', 'SPLIT',  null,  'WO', 'S2',  240, 'dp6@omexgears.com',  'PO ko work-order lots me todna'),
    ('S2',  'MATERIAL ASSESSMENT',   2,  'WO', 'NORMAL', 'S3',  null, null,  16,  'dp2@omexgears.com',  'Stock me material hai ya nahi'),
    ('S3',  'FINAL INDENT',          3,  'WO', 'NORMAL', 'S4',  null, null,  16,  'dp2@omexgears.com',  'Kharidne wale items ki list'),
    ('S4',  'PO RELEASE',            4,  'WO', 'NORMAL', 'S5',  null, null,  8,   'dp2@omexgears.com',  'Vendor PO release'),
    ('S5',  'MATERIAL RECEIVE (RM)', 5,  'WO', 'NORMAL', 'S6',  null, null,  240, 'dp10@omexgears.com', 'Raw material receipt'),
    ('S6',  'PRODUCTION WO RECEIVE', 6,  'WO', 'NORMAL', 'S7',  null, null,  56,  'dp10@omexgears.com', 'Production work order'),
    ('S7',  'ASSEMBLY PLANNING',     7,  'WO', 'SPLIT',  null,  'BO', 'S8',  100, 'dp6@omexgears.com',  'Assembly plan + qty BO stage me bhejna'),
    ('S8',  'BO ORDER',              8,  'BO', 'NORMAL', 'S9',  null, null,  16,  'dp2@omexgears.com',  'Bought-out items order'),
    ('S9',  'BO RECEIVED',           9,  'BO', 'NORMAL', 'S10', null, null,  40,  'dp10@omexgears.com', 'Bought-out items receipt'),
    ('S10', 'FG CONFIRMATION',       10, 'BO', 'SPLIT',  null,  'FG', 'S11', 56,  'dp10@omexgears.com', 'Finished goods ready qty'),
    ('S11', 'ASSIGN TO CLIENT',      11, 'FG', 'ASSIGN', null,  null, null,  120, 'dp6@omexgears.com',  'FG qty clients ko assign')
on conflict (step_code) do nothing;

-- ---------------------------------------------------------------------
-- 3. ORDERS, LOTS, TASKS
-- ---------------------------------------------------------------------
create table if not exists purchase_orders (
    po_number         text primary key check (length(trim(po_number)) > 0),
    lot_label         text,                      -- sheet "CLIENT NAME" column (e.g. "SEP 1st lot")
    series            text not null,
    model_no          text not null,
    total_qty         int  not null check (total_qty > 0),
    unit_price        numeric(12, 2) check (unit_price >= 0),
    expected_delivery date,
    priority          text not null default 'NORMAL' check (priority in ('NORMAL', 'URGENT')),
    status            text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'ON_HOLD', 'CANCELLED')),
    hold_started_at   timestamptz,
    remarks           text,
    created_by        text,
    created_at        timestamptz not null default now(),
    completed_at      timestamptz,
    is_legacy         boolean not null default false
);

create table if not exists lots (
    lot_key         text primary key,            -- PO/26/08/030-W1, PO/26/08/030-W1-B2, ...-F1
    legacy_key      text unique,                 -- old sheet "UNIQUE NO." (timestamp)
    po_number       text not null references purchase_orders(po_number),
    parent_lot_key  text references lots(lot_key),
    stage           text not null check (stage in ('WO', 'BO', 'FG')),
    seq             int  not null,
    qty             int  not null check (qty > 0),
    status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'ON_HOLD', 'CANCELLED')),
    priority        text not null default 'NORMAL' check (priority in ('NORMAL', 'URGENT')),
    planned_date    date,
    hold_started_at timestamptz,
    remarks         text,
    created_by      text,
    created_at      timestamptz not null default now(),
    completed_at    timestamptz
);
create index if not exists idx_lots_po     on lots (po_number);
create index if not exists idx_lots_parent on lots (parent_lot_key);

create table if not exists tasks (
    id               bigserial primary key,
    po_number        text not null references purchase_orders(po_number),
    lot_key          text references lots(lot_key),      -- NULL only for S1 (PO level)
    step_code        text not null references steps(step_code),
    doer_email       text not null references app_users(email),
    status           text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'REJECTED', 'CANCELLED')),
    planned_at       timestamptz not null,
    actual_at        timestamptz,
    attempt_no       int  not null default 1,
    data             jsonb not null default '{}'::jsonb,  -- step form data
    remarks          text,
    rejection_reason text,
    done_by          text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);
-- Never two open tasks for the same lot + step (protects against double taps)
create unique index if not exists uq_tasks_one_pending
    on tasks (po_number, coalesce(lot_key, ''), step_code) where status = 'PENDING';
create index if not exists idx_tasks_doer_status on tasks (doer_email, status);
create index if not exists idx_tasks_lot         on tasks (lot_key);
create index if not exists idx_tasks_po          on tasks (po_number);
create index if not exists idx_tasks_status_due  on tasks (status, planned_at);

create table if not exists client_assignments (
    id            bigserial primary key,
    po_number     text not null references purchase_orders(po_number),
    fg_lot_key    text not null references lots(lot_key),
    task_id       bigint references tasks(id),
    client_name   text not null check (length(trim(client_name)) > 0),
    qty           int  not null check (qty > 0),
    invoice_no    text,
    dispatch_date date,
    details       jsonb not null default '{}'::jsonb,
    created_by    text,
    created_at    timestamptz not null default now()
);
create index if not exists idx_assign_lot on client_assignments (fg_lot_key);

-- ---------------------------------------------------------------------
-- 4. NOTIFICATIONS, AUDIT, EDIT REQUESTS
-- ---------------------------------------------------------------------
create table if not exists notifications (
    id              bigserial primary key,
    task_id         bigint references tasks(id),
    recipient_email text not null,
    cc_email        text,
    channel         text not null default 'EMAIL',
    kind            text not null,     -- NEW_TASK, DUE_SOON, DUE_NOW, ESCALATION, DIGEST, INFO
    subject         text not null,
    body            text not null,
    status          text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
    attempts        int  not null default 0,
    error           text,
    created_at      timestamptz not null default now(),
    sent_at         timestamptz
);
create index if not exists idx_notif_pending on notifications (status, id);

create table if not exists reminder_log (
    task_id    bigint not null references tasks(id) on delete cascade,
    kind       text   not null,
    created_at timestamptz not null default now(),
    primary key (task_id, kind)
);

create table if not exists digest_log (
    doer_email  text not null,
    digest_date date not null,
    created_at  timestamptz not null default now(),
    primary key (doer_email, digest_date)
);

create table if not exists audit_log (
    id           bigserial primary key,
    actor_email  text,
    action       text not null,
    entity_type  text not null,
    entity_id    text,
    before_state jsonb,
    after_state  jsonb,
    created_at   timestamptz not null default now()
);
create index if not exists idx_audit_entity on audit_log (entity_type, entity_id);

create table if not exists edit_requests (
    id           bigserial primary key,
    task_id      bigint not null references tasks(id),
    requested_by text not null,
    old_data     jsonb,
    new_data     jsonb not null,
    reason       text,
    status       text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
    decided_by   text,
    decided_at   timestamptz,
    created_at   timestamptz not null default now()
);

-- =====================================================================
-- 5. HELPER FUNCTIONS
-- =====================================================================

-- Email of the logged-in user (from the Supabase JWT)
create or replace function fms_email() returns text
language sql stable as $$
    select lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
$$;

create or replace function fms_role() returns text
language sql stable security definer set search_path = public as $$
    select role from app_users where email = fms_email() and is_active
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
    select coalesce(fms_role() = 'ADMIN', false)
$$;

create or replace function cfg(p_key text) returns text
language sql stable security definer set search_path = public as $$
    select value from app_config where key = p_key
$$;

create or replace function is_working_day(p_day date) returns boolean
language sql stable security definer set search_path = public as $$
    select substr(coalesce(cfg('working_days'), '0000001'), extract(isodow from p_day)::int, 1) = '0'
       and not exists (select 1 from holidays where holiday_date = p_day)
$$;

-- Same logic as the sheet's Planned formula (WORKDAY.INTL + open/close time)
create or replace function add_working_hours(p_start timestamptz, p_hours numeric)
returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare
    v_tz      text := coalesce(cfg('timezone'), 'Asia/Kolkata');
    v_open    time := coalesce(cfg('open_time'), '09:00')::time;
    v_close   time := coalesce(cfg('close_time'), '17:30')::time;
    v_cur     timestamp := p_start at time zone v_tz;
    v_left    interval := make_interval(secs => greatest(p_hours, 0) * 3600);
    v_avail   interval;
    v_guard   int := 0;
begin
    loop
        v_guard := v_guard + 1;
        if v_guard > 5000 then
            raise exception 'add_working_hours: no working day found — check working_days config';
        end if;
        if not is_working_day(v_cur::date) or v_cur::time >= v_close then
            v_cur := (v_cur::date + 1) + v_open;
            continue;
        end if;
        if v_cur::time < v_open then
            v_cur := v_cur::date + v_open;
        end if;
        v_avail := (v_cur::date + v_close) - v_cur;
        if v_left <= v_avail then
            return (v_cur + v_left) at time zone v_tz;
        end if;
        v_left := v_left - v_avail;
        v_cur := (v_cur::date + 1) + v_open;
    end loop;
end;
$$;

-- Working hours between two moments (0 if b <= a)
create or replace function working_hours_between(p_from timestamptz, p_to timestamptz)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
    v_tz    text := coalesce(cfg('timezone'), 'Asia/Kolkata');
    v_open  time := coalesce(cfg('open_time'), '09:00')::time;
    v_close time := coalesce(cfg('close_time'), '17:30')::time;
    v_cur   timestamp := p_from at time zone v_tz;
    v_end   timestamp := p_to at time zone v_tz;
    v_total interval := interval '0';
    v_seg   timestamp;
begin
    if p_to is null or p_from is null or p_to <= p_from then
        return 0;
    end if;
    while v_cur < v_end loop
        if not is_working_day(v_cur::date) or v_cur::time >= v_close then
            v_cur := (v_cur::date + 1) + v_open;
            continue;
        end if;
        if v_cur::time < v_open then
            v_cur := v_cur::date + v_open;
            continue;
        end if;
        v_seg := least(v_cur::date + v_close, v_end);
        v_total := v_total + (v_seg - v_cur);
        v_cur := (v_cur::date + 1) + v_open;
    end loop;
    return round((extract(epoch from v_total) / 3600)::numeric, 2);
end;
$$;

create or replace function is_working_time(p_ts timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
    select is_working_day((p_ts at time zone coalesce(cfg('timezone'), 'Asia/Kolkata'))::date)
       and (p_ts at time zone coalesce(cfg('timezone'), 'Asia/Kolkata'))::time >= coalesce(cfg('open_time'), '09:00')::time
       and (p_ts at time zone coalesce(cfg('timezone'), 'Asia/Kolkata'))::time <  coalesce(cfg('close_time'), '17:30')::time
$$;

create or replace function fmt_ist(p_ts timestamptz) returns text
language sql stable security definer set search_path = public as $$
    select to_char(p_ts at time zone coalesce(cfg('timezone'), 'Asia/Kolkata'), 'DD Mon YYYY, HH24:MI')
$$;

-- Next PO number: PO/YY/MM/NNN, NNN continues through the year (like the sheet)
create or replace function suggest_po_number() returns text
language plpgsql stable security definer set search_path = public as $$
declare
    v_yy  text := to_char(now() at time zone 'Asia/Kolkata', 'YY');
    v_mm  text := to_char(now() at time zone 'Asia/Kolkata', 'MM');
    v_max int;
begin
    select max((regexp_match(po_number, '^PO/' || v_yy || '/\d{2}/(\d+)$'))[1]::int)
      into v_max
      from purchase_orders;
    return 'PO/' || v_yy || '/' || v_mm || '/' || lpad((coalesce(v_max, 0) + 1)::text, 3, '0');
end;
$$;

-- =====================================================================
-- 6. INTERNAL WORKFLOW FUNCTIONS (not callable from the website)
-- =====================================================================

create or replace function _actor() returns text
language sql stable as $$
    select coalesce(fms_email(), 'system')
$$;

create or replace function _require_user() returns text
language plpgsql stable security definer set search_path = public as $$
declare
    v_email text := fms_email();
begin
    if v_email is null or not exists (select 1 from app_users where email = v_email and is_active) then
        raise exception 'Aapka email FMS users list me nahi hai. Admin se contact karein.';
    end if;
    return v_email;
end;
$$;

create or replace function _require_admin() returns text
language plpgsql stable security definer set search_path = public as $$
declare
    v_email text := _require_user();
begin
    if not is_admin() then
        raise exception 'Sirf Super Admin ye kar sakta hai.';
    end if;
    return v_email;
end;
$$;

create or replace function _audit(p_action text, p_type text, p_id text, p_before jsonb, p_after jsonb)
returns void
language sql security definer set search_path = public as $$
    insert into audit_log (actor_email, action, entity_type, entity_id, before_state, after_state)
    values (_actor(), p_action, p_type, p_id, p_before, p_after);
$$;

-- Queue an email about one task
create or replace function _notify_task(p_task_id bigint, p_kind text, p_cc text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
    r record;
    v_title text;
begin
    select t.*, s.step_name, p.series, p.model_no, p.lot_label, l.qty as lot_qty, p.total_qty
      into r
      from tasks t
      join steps s on s.step_code = t.step_code
      join purchase_orders p on p.po_number = t.po_number
      left join lots l on l.lot_key = t.lot_key
     where t.id = p_task_id;
    if not found then
        return;
    end if;

    v_title := case p_kind
        when 'NEW_TASK'   then 'New task'
        when 'DUE_SOON'   then 'Due soon'
        when 'DUE_NOW'    then 'Due now'
        when 'ESCALATION' then 'OVERDUE (escalation)'
        else p_kind end;

    insert into notifications (task_id, recipient_email, cc_email, kind, subject, body)
    values (
        r.id, r.doer_email, p_cc, p_kind,
        format('[Omex FMS] %s — %s — %s', v_title, r.step_name, coalesce(r.lot_key, r.po_number)),
        format(E'Step: %s - %s\nPO: %s\nLot: %s\nProduct: %s %s\nQty: %s\nDue by: %s',
               r.step_code, r.step_name, r.po_number, coalesce(r.lot_key, '-'),
               r.series, r.model_no, coalesce(r.lot_qty, r.total_qty), fmt_ist(r.planned_at))
    );
end;
$$;

-- Create a PENDING task. Planned = start + TAT (working hours). Attempt = previous attempts + 1.
create or replace function _spawn_task(p_po text, p_lot text, p_step text, p_start timestamptz, p_remarks text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
    s       steps%rowtype;
    v_try   int;
    v_id    bigint;
begin
    select * into s from steps where step_code = p_step;
    if not found then
        raise exception 'Unknown step %', p_step;
    end if;
    select coalesce(max(attempt_no), 0) + 1 into v_try
      from tasks
     where po_number = p_po and lot_key is not distinct from p_lot and step_code = p_step;

    insert into tasks (po_number, lot_key, step_code, doer_email, planned_at, attempt_no, remarks)
    values (p_po, p_lot, p_step, s.doer_email, add_working_hours(p_start, s.tat_hours), v_try, p_remarks)
    returning id into v_id;

    perform _notify_task(v_id, 'NEW_TASK');
    return v_id;
end;
$$;

-- Lock a task for an action and check permissions + hold/cancel state
create or replace function _lock_task(p_task_id bigint) returns tasks
language plpgsql security definer set search_path = public as $$
declare
    t       tasks%rowtype;
    v_email text := _require_user();
    v_po    text;
    v_lot   text;
begin
    select * into t from tasks where id = p_task_id for update;
    if not found then
        raise exception 'Task % nahi mila', p_task_id;
    end if;
    if t.doer_email <> v_email and not is_admin() then
        raise exception 'Ye task aapka nahi hai.';
    end if;
    if t.status <> 'PENDING' then
        raise exception 'Ye task already % hai.', t.status;
    end if;
    select status into v_po from purchase_orders where po_number = t.po_number;
    if v_po in ('ON_HOLD', 'CANCELLED') then
        raise exception 'PO % abhi % hai — kaam nahi ho sakta.', t.po_number, v_po;
    end if;
    if t.lot_key is not null then
        select status into v_lot from lots where lot_key = t.lot_key;
        if v_lot in ('ON_HOLD', 'CANCELLED') then
            raise exception 'Lot % abhi % hai — kaam nahi ho sakta.', t.lot_key, v_lot;
        end if;
    end if;
    return t;
end;
$$;

-- Qty still to be split / assigned for a SPLIT or ASSIGN task
create or replace function task_balance(p_task_id bigint) returns int
language plpgsql stable security definer set search_path = public as $$
declare
    t      tasks%rowtype;
    s      steps%rowtype;
    v_tot  int;
    v_used int;
begin
    select * into t from tasks where id = p_task_id;
    select * into s from steps where step_code = t.step_code;
    if s.step_type = 'SPLIT' and t.lot_key is null then
        select total_qty into v_tot from purchase_orders where po_number = t.po_number;
        select coalesce(sum(qty), 0) into v_used from lots
         where po_number = t.po_number and parent_lot_key is null and stage = s.child_stage;
    elsif s.step_type = 'SPLIT' then
        select qty into v_tot from lots where lot_key = t.lot_key;
        select coalesce(sum(qty), 0) into v_used from lots where parent_lot_key = t.lot_key;
    elsif s.step_type = 'ASSIGN' then
        select qty into v_tot from lots where lot_key = t.lot_key;
        select coalesce(sum(qty), 0) into v_used from client_assignments where fg_lot_key = t.lot_key;
    else
        return null;
    end if;
    return v_tot - v_used;
end;
$$;

-- Mark PO COMPLETED when S1 is done and no lot / task is still open
create or replace function _check_po_complete(p_po text) returns void
language plpgsql security definer set search_path = public as $$
begin
    if exists (select 1 from tasks where po_number = p_po and status = 'PENDING') then return; end if;
    if not exists (select 1 from tasks where po_number = p_po and step_code = 'S1' and status = 'DONE') then return; end if;
    if exists (select 1 from lots where po_number = p_po and status in ('ACTIVE', 'ON_HOLD')) then return; end if;
    update purchase_orders
       set status = case when exists (select 1 from lots where po_number = p_po and status = 'COMPLETED')
                         then 'COMPLETED' else 'CANCELLED' end,
           completed_at = now()
     where po_number = p_po and status = 'ACTIVE';
end;
$$;

-- lot + all descendants
create or replace function _lot_tree(p_lot text) returns setof text
language sql stable security definer set search_path = public as $$
    with recursive tree as (
        select lot_key from lots where lot_key = p_lot
        union all
        select l.lot_key from lots l join tree on l.parent_lot_key = tree.lot_key
    )
    select lot_key from tree
$$;

-- =====================================================================
-- 7. ACTIONS CALLED FROM THE WEBSITE (RPC)
-- =====================================================================

-- 7a. Sales creates a PO → S1 task for Neha
create or replace function create_po(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_email text := _require_user();
    v_po    text := upper(trim(p ->> 'po_number'));
    v_task  bigint;
begin
    if fms_role() not in ('ADMIN', 'SALES') then
        raise exception 'Sirf Sales Admin ya Super Admin naya PO bana sakte hain.';
    end if;
    if v_po is null or v_po = '' then raise exception 'PO Number zaroori hai.'; end if;
    if coalesce(trim(p ->> 'series'), '') = '' then raise exception 'Series zaroori hai.'; end if;
    if coalesce(trim(p ->> 'model_no'), '') = '' then raise exception 'Model No zaroori hai.'; end if;
    if coalesce((p ->> 'total_qty')::int, 0) <= 0 then raise exception 'Qty 0 se zyada honi chahiye.'; end if;

    if exists (select 1 from purchase_orders where po_number = v_po) then
        raise exception 'DUPLICATE_PO: % already exists. Next available: %', v_po, suggest_po_number();
    end if;

    insert into purchase_orders (po_number, lot_label, series, model_no, total_qty, unit_price,
                                 expected_delivery, priority, remarks, created_by)
    values (v_po,
            nullif(trim(p ->> 'lot_label'), ''),
            upper(trim(p ->> 'series')),
            trim(p ->> 'model_no'),
            (p ->> 'total_qty')::int,
            nullif(p ->> 'unit_price', '')::numeric,
            nullif(p ->> 'expected_delivery', '')::date,
            coalesce(nullif(p ->> 'priority', ''), 'NORMAL'),
            nullif(trim(p ->> 'remarks'), ''),
            v_email);

    v_task := _spawn_task(v_po, null, 'S1', now());
    perform _audit('CREATE_PO', 'PO', v_po, null, p);
    return jsonb_build_object('po_number', v_po, 'task_id', v_task);
end;
$$;

-- 7b. Mark a NORMAL step done → next step created automatically
create or replace function complete_task(p_task_id bigint, p_data jsonb default '{}'::jsonb, p_remarks text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    t      tasks%rowtype := _lock_task(p_task_id);
    s      steps%rowtype;
    v_next bigint;
begin
    select * into s from steps where step_code = t.step_code;
    if s.step_type <> 'NORMAL' then
        raise exception '% ek % step hai — split/assign screen use karein.', s.step_code, s.step_type;
    end if;

    update tasks
       set status = 'DONE', actual_at = now(), done_by = _actor(),
           data = coalesce(p_data, '{}'::jsonb), remarks = coalesce(p_remarks, remarks), updated_at = now()
     where id = t.id;

    if s.next_step_code is not null then
        v_next := _spawn_task(t.po_number, t.lot_key, s.next_step_code, now());
    end if;

    perform _audit('MARK_DONE', 'TASK', t.id::text, to_jsonb(t), jsonb_build_object('data', p_data, 'remarks', p_remarks));
    return jsonb_build_object('done_task', t.id, 'next_task', v_next);
end;
$$;

-- 7c. Split (S1 / S7 / S10). p_parts = [{"qty":3,"planned_date":"2026-11-01","priority":"URGENT","remarks":".."}]
--     Partial split allowed: task stays PENDING until balance = 0.
create or replace function split_task(p_task_id bigint, p_parts jsonb, p_data jsonb default '{}'::jsonb, p_remarks text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    t         tasks%rowtype := _lock_task(p_task_id);
    s         steps%rowtype;
    v_parent  lots%rowtype;
    v_balance int;
    v_sum     int := 0;
    v_part    jsonb;
    v_seq     int;
    v_key     text;
    v_prio    text;
    v_created jsonb := '[]'::jsonb;
    v_child   bigint;
begin
    select * into s from steps where step_code = t.step_code;
    if s.step_type <> 'SPLIT' then
        raise exception '% split step nahi hai.', s.step_code;
    end if;
    if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
        raise exception 'Kam se kam ek split row chahiye.';
    end if;

    -- serialize concurrent splits on the same parent
    if t.lot_key is null then
        perform 1 from purchase_orders where po_number = t.po_number for update;
        v_prio := (select priority from purchase_orders where po_number = t.po_number);
    else
        select * into v_parent from lots where lot_key = t.lot_key for update;
        v_prio := v_parent.priority;
    end if;

    v_balance := task_balance(t.id);
    for v_part in select * from jsonb_array_elements(p_parts) loop
        if coalesce((v_part ->> 'qty')::numeric, 0) <= 0 or (v_part ->> 'qty')::numeric <> trunc((v_part ->> 'qty')::numeric) then
            raise exception 'Har split ki qty poora number aur 0 se zyada honi chahiye.';
        end if;
        v_sum := v_sum + (v_part ->> 'qty')::int;
    end loop;
    if v_sum > v_balance then
        raise exception 'Total qty % hai par balance sirf % bacha hai.', v_sum, v_balance;
    end if;

    for v_part in select * from jsonb_array_elements(p_parts) loop
        if t.lot_key is null then
            select coalesce(max(seq), 0) + 1 into v_seq from lots where po_number = t.po_number and parent_lot_key is null;
            v_key := t.po_number || '-W' || v_seq;
        else
            select coalesce(max(seq), 0) + 1 into v_seq from lots where parent_lot_key = t.lot_key;
            v_key := t.lot_key || '-' || left(s.child_stage, 1) || v_seq;
        end if;

        insert into lots (lot_key, po_number, parent_lot_key, stage, seq, qty, priority, planned_date, remarks, created_by)
        values (v_key, t.po_number, t.lot_key, s.child_stage, v_seq, (v_part ->> 'qty')::int,
                coalesce(nullif(v_part ->> 'priority', ''), v_prio),
                nullif(v_part ->> 'planned_date', '')::date,
                nullif(trim(v_part ->> 'remarks'), ''),
                _actor());

        v_child := _spawn_task(t.po_number, v_key, s.child_first_step, now());
        v_created := v_created || jsonb_build_object('lot_key', v_key, 'qty', (v_part ->> 'qty')::int, 'task_id', v_child);
    end loop;

    v_balance := v_balance - v_sum;
    update tasks
       set data = (data || coalesce(p_data, '{}'::jsonb))
                  || jsonb_build_object('batches', coalesce(data -> 'batches', '[]'::jsonb)
                        || jsonb_build_object('at', now(), 'by', _actor(), 'lots', v_created)),
           remarks = coalesce(p_remarks, remarks),
           updated_at = now()
     where id = t.id;

    if v_balance = 0 then
        update tasks set status = 'DONE', actual_at = now(), done_by = _actor() where id = t.id;
        if t.lot_key is not null then
            update lots set status = 'COMPLETED', completed_at = now() where lot_key = t.lot_key;
        end if;
    end if;

    perform _audit('SPLIT', 'TASK', t.id::text, null, jsonb_build_object('lots', v_created, 'balance', v_balance));
    perform _check_po_complete(t.po_number);
    return jsonb_build_object('created', v_created, 'balance', v_balance, 'task_done', v_balance = 0);
end;
$$;

-- 7d. S11: assign FG qty to clients. p_rows = [{"client_name":"DSEPS","qty":1,"invoice_no":"..","dispatch_date":"2026-10-20", ...}]
create or replace function assign_clients(p_task_id bigint, p_rows jsonb, p_remarks text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    t         tasks%rowtype := _lock_task(p_task_id);
    s         steps%rowtype;
    v_balance int;
    v_sum     int := 0;
    v_row     jsonb;
begin
    select * into s from steps where step_code = t.step_code;
    if s.step_type <> 'ASSIGN' then
        raise exception '% assign step nahi hai.', s.step_code;
    end if;
    if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
        raise exception 'Kam se kam ek client row chahiye.';
    end if;
    perform 1 from lots where lot_key = t.lot_key for update;
    v_balance := task_balance(t.id);

    for v_row in select * from jsonb_array_elements(p_rows) loop
        if coalesce(trim(v_row ->> 'client_name'), '') = '' then
            raise exception 'Client name khali nahi ho sakta.';
        end if;
        if coalesce((v_row ->> 'qty')::numeric, 0) <= 0 or (v_row ->> 'qty')::numeric <> trunc((v_row ->> 'qty')::numeric) then
            raise exception 'Qty poora number aur 0 se zyada honi chahiye.';
        end if;
        v_sum := v_sum + (v_row ->> 'qty')::int;
    end loop;
    if v_sum > v_balance then
        raise exception 'Total qty % hai par balance sirf % bacha hai.', v_sum, v_balance;
    end if;

    for v_row in select * from jsonb_array_elements(p_rows) loop
        insert into client_assignments (po_number, fg_lot_key, task_id, client_name, qty, invoice_no, dispatch_date, details, created_by)
        values (t.po_number, t.lot_key, t.id, upper(trim(v_row ->> 'client_name')), (v_row ->> 'qty')::int,
                nullif(trim(v_row ->> 'invoice_no'), ''), nullif(v_row ->> 'dispatch_date', '')::date,
                v_row - 'client_name' - 'qty' - 'invoice_no' - 'dispatch_date', _actor());
    end loop;

    v_balance := v_balance - v_sum;
    update tasks set remarks = coalesce(p_remarks, remarks), updated_at = now() where id = t.id;
    if v_balance = 0 then
        update tasks set status = 'DONE', actual_at = now(), done_by = _actor() where id = t.id;
        update lots set status = 'COMPLETED', completed_at = now() where lot_key = t.lot_key;
    end if;

    perform _audit('ASSIGN_CLIENT', 'TASK', t.id::text, null, jsonb_build_object('rows', p_rows, 'balance', v_balance));
    perform _check_po_complete(t.po_number);
    return jsonb_build_object('balance', v_balance, 'task_done', v_balance = 0);
end;
$$;

-- 7e. Reject → previous step of the same lot reopens with attempt_no + 1
create or replace function reject_task(p_task_id bigint, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    t      tasks%rowtype := _lock_task(p_task_id);
    v_prev text;
    v_new  bigint;
begin
    if coalesce(trim(p_reason), '') = '' then
        raise exception 'Reject ka reason likhna zaroori hai.';
    end if;
    select step_code into v_prev from steps where next_step_code = t.step_code;
    if v_prev is null then
        raise exception '% is stage ka pehla step hai — peeche reject nahi ho sakta. Super Admin se contact karein.', t.step_code;
    end if;
    if exists (select 1 from lots where parent_lot_key = t.lot_key) then
        raise exception 'Is lot ki qty aage bhej di gayi hai — reject nahi ho sakta.';
    end if;

    update tasks
       set status = 'REJECTED', rejection_reason = p_reason, actual_at = now(), done_by = _actor(), updated_at = now()
     where id = t.id;

    v_new := _spawn_task(t.po_number, t.lot_key, v_prev, now(),
                         'Reopened: rejected at ' || t.step_code || ' — ' || p_reason);

    perform _audit('REJECT', 'TASK', t.id::text, to_jsonb(t), jsonb_build_object('reason', p_reason, 'reopened_task', v_new));
    return jsonb_build_object('rejected_task', t.id, 'reopened_task', v_new, 'step', v_prev);
end;
$$;

-- 7f. Hold / resume / cancel (Super Admin). Pass a PO number OR a lot key.
create or replace function hold_work(p_po text, p_lot text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_n int;
begin
    perform _require_admin();
    if p_lot is not null then
        update lots set status = 'ON_HOLD', hold_started_at = now()
         where lot_key in (select _lot_tree(p_lot)) and status = 'ACTIVE';
        get diagnostics v_n = row_count;
        perform _audit('HOLD', 'LOT', p_lot, null, jsonb_build_object('reason', p_reason, 'lots', v_n));
    else
        update purchase_orders set status = 'ON_HOLD', hold_started_at = now()
         where po_number = p_po and status = 'ACTIVE';
        if not found then raise exception 'PO % active nahi hai.', p_po; end if;
        update lots set status = 'ON_HOLD', hold_started_at = now() where po_number = p_po and status = 'ACTIVE';
        perform _audit('HOLD', 'PO', p_po, null, jsonb_build_object('reason', p_reason));
    end if;
    return jsonb_build_object('ok', true);
end;
$$;

-- On resume, pending due dates move forward by the working hours spent on hold
create or replace function resume_work(p_po text, p_lot text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_since timestamptz;
    v_hours numeric;
    v_lots  text[];
    v_tasks bigint[];
begin
    perform _require_admin();
    if p_lot is not null then
        select hold_started_at into v_since from lots where lot_key = p_lot and status = 'ON_HOLD';
        if v_since is null then raise exception 'Lot % hold par nahi hai.', p_lot; end if;
        select array_agg(k) into v_lots from _lot_tree(p_lot) k;
        update lots set status = 'ACTIVE', hold_started_at = null where lot_key = any(v_lots) and status = 'ON_HOLD';
        select array_agg(id) into v_tasks from tasks where lot_key = any(v_lots) and status = 'PENDING';
    else
        select hold_started_at into v_since from purchase_orders where po_number = p_po and status = 'ON_HOLD';
        if v_since is null then raise exception 'PO % hold par nahi hai.', p_po; end if;
        update purchase_orders set status = 'ACTIVE', hold_started_at = null where po_number = p_po;
        update lots set status = 'ACTIVE', hold_started_at = null where po_number = p_po and status = 'ON_HOLD';
        select array_agg(id) into v_tasks from tasks where po_number = p_po and status = 'PENDING';
    end if;

    v_hours := working_hours_between(v_since, now());
    update tasks set planned_at = add_working_hours(planned_at, v_hours), updated_at = now()
     where id = any(coalesce(v_tasks, '{}'));
    delete from reminder_log where task_id = any(coalesce(v_tasks, '{}'));

    perform _audit('RESUME', case when p_lot is null then 'PO' else 'LOT' end, coalesce(p_lot, p_po),
                   null, jsonb_build_object('hold_hours', v_hours, 'tasks_shifted', coalesce(array_length(v_tasks, 1), 0)));
    return jsonb_build_object('hold_hours', v_hours, 'tasks_shifted', coalesce(array_length(v_tasks, 1), 0));
end;
$$;

-- Cancelled qty is NOT returned to the parent's balance.
create or replace function cancel_work(p_po text, p_lot text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_lots text[];
    v_po   text;
    v_n    int;
begin
    perform _require_admin();
    if coalesce(trim(p_reason), '') = '' then raise exception 'Cancel ka reason zaroori hai.'; end if;
    if p_lot is not null then
        select po_number into v_po from lots where lot_key = p_lot;
        if v_po is null then raise exception 'Lot % nahi mila.', p_lot; end if;
        select array_agg(k) into v_lots from _lot_tree(p_lot) k;
        update lots set status = 'CANCELLED', remarks = coalesce(remarks || ' | ', '') || 'Cancelled: ' || p_reason
         where lot_key = any(v_lots) and status in ('ACTIVE', 'ON_HOLD');
        update tasks set status = 'CANCELLED', rejection_reason = p_reason, updated_at = now()
         where lot_key = any(v_lots) and status = 'PENDING';
        get diagnostics v_n = row_count;
        perform _audit('CANCEL', 'LOT', p_lot, null, jsonb_build_object('reason', p_reason, 'tasks_cancelled', v_n));
    else
        v_po := p_po;
        update purchase_orders set status = 'CANCELLED', completed_at = now(),
               remarks = coalesce(remarks || ' | ', '') || 'Cancelled: ' || p_reason
         where po_number = p_po and status in ('ACTIVE', 'ON_HOLD');
        if not found then raise exception 'PO % cancel nahi ho sakta (already completed/cancelled?).', p_po; end if;
        update lots set status = 'CANCELLED' where po_number = p_po and status in ('ACTIVE', 'ON_HOLD');
        update tasks set status = 'CANCELLED', rejection_reason = p_reason, updated_at = now()
         where po_number = p_po and status = 'PENDING';
        get diagnostics v_n = row_count;
        perform _audit('CANCEL', 'PO', p_po, null, jsonb_build_object('reason', p_reason, 'tasks_cancelled', v_n));
    end if;
    perform _check_po_complete(v_po);
    return jsonb_build_object('tasks_cancelled', v_n);
end;
$$;

-- 7g. Reassign
create or replace function reassign_task(p_task_id bigint, p_new_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_old text;
begin
    perform _require_admin();
    if not exists (select 1 from app_users where email = lower(p_new_email) and is_active) then
        raise exception '% users list me nahi hai.', p_new_email;
    end if;
    select doer_email into v_old from tasks where id = p_task_id and status = 'PENDING' for update;
    if not found then raise exception 'Pending task % nahi mila.', p_task_id; end if;
    update tasks set doer_email = lower(p_new_email), updated_at = now() where id = p_task_id;
    perform _notify_task(p_task_id, 'NEW_TASK');
    perform _audit('REASSIGN', 'TASK', p_task_id::text, jsonb_build_object('doer', v_old), jsonb_build_object('doer', lower(p_new_email)));
    return jsonb_build_object('ok', true);
end;
$$;

create or replace function reassign_step(p_step text, p_new_email text, p_move_pending boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_old text;
    v_id  bigint;
    v_n   int := 0;
begin
    perform _require_admin();
    if not exists (select 1 from app_users where email = lower(p_new_email) and is_active) then
        raise exception '% users list me nahi hai.', p_new_email;
    end if;
    select doer_email into v_old from steps where step_code = p_step;
    update steps set doer_email = lower(p_new_email), updated_at = now() where step_code = p_step;
    if p_move_pending then
        for v_id in update tasks set doer_email = lower(p_new_email), updated_at = now()
                     where step_code = p_step and status = 'PENDING' and doer_email <> lower(p_new_email)
                     returning id
        loop
            perform _notify_task(v_id, 'NEW_TASK');
            v_n := v_n + 1;
        end loop;
    end if;
    perform _audit('REASSIGN_STEP', 'STEP', p_step, jsonb_build_object('doer', v_old),
                   jsonb_build_object('doer', lower(p_new_email), 'tasks_moved', v_n));
    return jsonb_build_object('tasks_moved', v_n);
end;
$$;

-- 7h. Edit after submit: within edit window → direct; later → request for admin approval
create or replace function edit_task_data(p_task_id bigint, p_data jsonb, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_email text := _require_user();
    t       tasks%rowtype;
    v_win   int := coalesce(cfg('edit_window_minutes'), '60')::int;
begin
    select * into t from tasks where id = p_task_id for update;
    if not found or t.status <> 'DONE' then
        raise exception 'Sirf DONE task ka data edit ho sakta hai.';
    end if;
    if not is_admin() and t.doer_email <> v_email and coalesce(t.done_by, '') <> v_email then
        raise exception 'Ye task aapka nahi hai.';
    end if;
    -- split / assign history stays as it is
    p_data := (coalesce(p_data, '{}'::jsonb) - 'batches') || coalesce(jsonb_build_object('batches', t.data -> 'batches'), '{}'::jsonb);
    p_data := jsonb_strip_nulls(p_data);

    if is_admin() or now() <= t.actual_at + make_interval(mins => v_win) then
        update tasks set data = p_data, updated_at = now() where id = t.id;
        perform _audit('EDIT', 'TASK', t.id::text, t.data, p_data);
        return jsonb_build_object('status', 'UPDATED');
    end if;

    insert into edit_requests (task_id, requested_by, old_data, new_data, reason)
    values (t.id, v_email, t.data, p_data, p_reason);
    insert into notifications (task_id, recipient_email, kind, subject, body)
    select t.id, email, 'INFO', '[Omex FMS] Edit approval needed — task ' || t.id,
           format(E'%s wants to edit %s (%s).\nReason: %s', v_email, t.step_code, coalesce(t.lot_key, t.po_number), coalesce(p_reason, '-'))
      from app_users where role = 'ADMIN' and is_active;
    return jsonb_build_object('status', 'REQUESTED');
end;
$$;

create or replace function decide_edit(p_request_id bigint, p_approve boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    r edit_requests%rowtype;
begin
    perform _require_admin();
    select * into r from edit_requests where id = p_request_id and status = 'PENDING' for update;
    if not found then raise exception 'Request % pending nahi hai.', p_request_id; end if;
    update edit_requests set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
           decided_by = _actor(), decided_at = now()
     where id = r.id;
    if p_approve then
        update tasks set data = r.new_data, updated_at = now() where id = r.task_id;
        perform _audit('EDIT_APPROVED', 'TASK', r.task_id::text, r.old_data, r.new_data);
    end if;
    return jsonb_build_object('ok', true);
end;
$$;

-- 7i. Task detail with full history of the lot chain (for the task screen)
create or replace function get_task_detail(p_task_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
    v_email text := _require_user();
    t       tasks%rowtype;
    v_chain text[];
    v_res   jsonb;
begin
    select * into t from tasks where id = p_task_id;
    if not found then raise exception 'Task % nahi mila.', p_task_id; end if;
    if t.doer_email <> v_email and coalesce(t.done_by, '') <> v_email and fms_role() not in ('ADMIN', 'SALES') then
        raise exception 'Ye task aapka nahi hai.';
    end if;

    -- this lot and its ancestors
    with recursive up as (
        select lot_key, parent_lot_key from lots where lot_key = t.lot_key
        union all
        select l.lot_key, l.parent_lot_key from lots l join up on l.lot_key = up.parent_lot_key
    )
    select array_agg(lot_key) into v_chain from up;

    select jsonb_build_object(
        'task',    to_jsonb(t) || jsonb_build_object('balance', task_balance(t.id)),
        'step',    (select to_jsonb(s) from steps s where s.step_code = t.step_code),
        'po',      (select to_jsonb(p) from purchase_orders p where p.po_number = t.po_number),
        'lot',     (select to_jsonb(l) from lots l where l.lot_key = t.lot_key),
        'chain',   coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at) from lots l where l.lot_key = any(v_chain)), '[]'::jsonb),
        'children',coalesce((select jsonb_agg(to_jsonb(l) order by l.seq) from lots l
                              where (t.lot_key is null and l.po_number = t.po_number and l.parent_lot_key is null)
                                 or (t.lot_key is not null and l.parent_lot_key = t.lot_key)), '[]'::jsonb),
        'assignments', coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from client_assignments a where a.fg_lot_key = t.lot_key), '[]'::jsonb),
        'history', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', h.id, 'step_code', h.step_code, 'step_name', s.step_name, 'lot_key', h.lot_key,
                         'status', h.status, 'planned_at', h.planned_at, 'actual_at', h.actual_at,
                         'attempt_no', h.attempt_no, 'doer_email', h.doer_email, 'data', h.data,
                         'remarks', h.remarks, 'rejection_reason', h.rejection_reason)
                         order by s.step_order, h.id)
                       from tasks h join steps s on s.step_code = h.step_code
                      where h.po_number = t.po_number
                        and (h.lot_key is null or h.lot_key = any(coalesce(v_chain, '{}')))), '[]'::jsonb),
        'edit_window_minutes', coalesce(cfg('edit_window_minutes'), '60')::int
    ) into v_res;
    return v_res;
end;
$$;

-- 7j. PO progress list for Sales/Admin (current open step of every lot)
create or replace function po_progress(p_status text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
    perform _require_user();
    if fms_role() not in ('ADMIN', 'SALES') then
        raise exception 'Sirf Sales / Super Admin.';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'po', to_jsonb(p),
            'balance_to_split', p.total_qty - coalesce((select sum(qty) from lots where po_number = p.po_number and parent_lot_key is null), 0),
            'assigned_qty', coalesce((select sum(qty) from client_assignments where po_number = p.po_number), 0),
            'lots', coalesce((select jsonb_agg(jsonb_build_object(
                        'lot_key', l.lot_key, 'parent', l.parent_lot_key, 'stage', l.stage, 'qty', l.qty,
                        'status', l.status, 'priority', l.priority, 'legacy_key', l.legacy_key,
                        'open', (select jsonb_agg(jsonb_build_object('id', t.id, 'step', t.step_code, 'doer', t.doer_email,
                                                                     'planned_at', t.planned_at))
                                   from tasks t where t.lot_key = l.lot_key and t.status = 'PENDING'))
                        order by l.lot_key) from lots l where l.po_number = p.po_number), '[]'::jsonb),
            'po_open', (select jsonb_agg(jsonb_build_object('id', t.id, 'step', t.step_code, 'planned_at', t.planned_at))
                          from tasks t where t.po_number = p.po_number and t.lot_key is null and t.status = 'PENDING')
        ) order by p.created_at desc)
        from purchase_orders p
        where p_status is null or p.status = p_status
    ), '[]'::jsonb);
end;
$$;

-- =====================================================================
-- 8. REMINDERS (pg_cron runs this every 15 minutes — see 02_cron.sql)
--    12 working hrs before due → DUE_SOON
--    at due time             → DUE_NOW
--    12 working hrs overdue  → ESCALATION (CC super admin)
--    every working morning   → one DIGEST email per doer with all overdue tasks
--    Nothing is queued outside working hours / on Sundays / holidays,
--    and ON_HOLD / CANCELLED work is skipped.
-- =====================================================================
create or replace function queue_reminders() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_now      timestamptz := now();
    v_soon     numeric := coalesce(cfg('due_soon_hours'), '12')::numeric;
    v_esc      numeric := coalesce(cfg('escalate_after_hours'), '12')::numeric;
    v_cc       text := cfg('escalation_cc');
    v_tz       text := coalesce(cfg('timezone'), 'Asia/Kolkata');
    v_today    date := (now() at time zone coalesce(cfg('timezone'), 'Asia/Kolkata'))::date;
    r          record;
    v_n        int;
    v_counts   jsonb := '{}'::jsonb;
    v_body     text;
begin
    if not is_working_time(v_now) then
        return jsonb_build_object('skipped', 'outside working hours');
    end if;

    for r in
        select t.id, t.planned_at, s.tat_hours
          from tasks t
          join steps s on s.step_code = t.step_code
          join purchase_orders p on p.po_number = t.po_number
          left join lots l on l.lot_key = t.lot_key
         where t.status = 'PENDING' and p.status = 'ACTIVE' and coalesce(l.status, 'ACTIVE') = 'ACTIVE'
    loop
        if r.planned_at > v_now then
            -- skip "due soon" for steps whose whole TAT is shorter than the warning window
            if r.tat_hours > v_soon and r.planned_at < v_now + interval '10 days'
               and working_hours_between(v_now, r.planned_at) <= v_soon then
                insert into reminder_log (task_id, kind) values (r.id, 'DUE_SOON') on conflict do nothing;
                get diagnostics v_n = row_count;
                if v_n > 0 then
                    perform _notify_task(r.id, 'DUE_SOON');
                    v_counts := jsonb_set(v_counts, '{due_soon}', to_jsonb(coalesce((v_counts ->> 'due_soon')::int, 0) + 1));
                end if;
            end if;
        else
            insert into reminder_log (task_id, kind) values (r.id, 'DUE_NOW') on conflict do nothing;
            get diagnostics v_n = row_count;
            if v_n > 0 then
                perform _notify_task(r.id, 'DUE_NOW');
                v_counts := jsonb_set(v_counts, '{due_now}', to_jsonb(coalesce((v_counts ->> 'due_now')::int, 0) + 1));
            end if;
            if not exists (select 1 from reminder_log where task_id = r.id and kind = 'ESCALATION')
               and working_hours_between(r.planned_at, v_now) >= v_esc then
                insert into reminder_log (task_id, kind) values (r.id, 'ESCALATION') on conflict do nothing;
                perform _notify_task(r.id, 'ESCALATION', v_cc);
                v_counts := jsonb_set(v_counts, '{escalation}', to_jsonb(coalesce((v_counts ->> 'escalation')::int, 0) + 1));
            end if;
        end if;
    end loop;

    -- Morning digest: one email per doer listing every overdue task
    if (v_now at time zone v_tz)::time >= coalesce(cfg('digest_time'), '09:30')::time then
        for r in
            select t.doer_email, count(*) as n,
                   string_agg(format('• %s %s — %s — due %s', t.step_code, s.step_name,
                                     coalesce(t.lot_key, t.po_number), fmt_ist(t.planned_at)),
                              E'\n' order by t.planned_at) as lines
              from tasks t
              join steps s on s.step_code = t.step_code
              join purchase_orders p on p.po_number = t.po_number
              left join lots l on l.lot_key = t.lot_key
             where t.status = 'PENDING' and t.planned_at < v_now
               and p.status = 'ACTIVE' and coalesce(l.status, 'ACTIVE') = 'ACTIVE'
               and not exists (select 1 from digest_log d where d.doer_email = t.doer_email and d.digest_date = v_today)
             group by t.doer_email
        loop
            insert into digest_log (doer_email, digest_date) values (r.doer_email, v_today) on conflict do nothing;
            v_body := format(E'Aapke %s task overdue hain:\n\n%s', r.n, r.lines);
            insert into notifications (recipient_email, kind, subject, body)
            values (r.doer_email, 'DIGEST', format('[Omex FMS] %s overdue tasks — %s', r.n, to_char(v_today, 'DD Mon')), v_body);
            v_counts := jsonb_set(v_counts, '{digest}', to_jsonb(coalesce((v_counts ->> 'digest')::int, 0) + 1));
        end loop;
    end if;

    return v_counts;
end;
$$;

-- =====================================================================
-- 9. ROW LEVEL SECURITY
--    Doers see only their own tasks. Super Admin sees everything.
--    All changes go through the functions above (no direct writes),
--    except Super Admin editing settings tables.
-- =====================================================================
do $$
declare
    tbl text;
begin
    foreach tbl in array array['app_config', 'holidays', 'app_users', 'steps', 'purchase_orders', 'lots', 'tasks',
                               'client_assignments', 'notifications', 'reminder_log', 'digest_log', 'audit_log', 'edit_requests']
    loop
        execute format('alter table %I enable row level security', tbl);
    end loop;
end $$;

-- readable by every logged-in user, writable by Super Admin
do $$
declare
    tbl text;
begin
    foreach tbl in array array['app_config', 'holidays', 'app_users', 'steps', 'purchase_orders', 'lots', 'client_assignments']
    loop
        execute format('drop policy if exists read_all on %I', tbl);
        execute format('create policy read_all on %I for select to authenticated using (true)', tbl);
        execute format('drop policy if exists admin_write on %I', tbl);
        execute format('create policy admin_write on %I for all to authenticated using (is_admin()) with check (is_admin())', tbl);
    end loop;
    foreach tbl in array array['notifications', 'reminder_log', 'digest_log', 'audit_log']
    loop
        execute format('drop policy if exists admin_read on %I', tbl);
        execute format('create policy admin_read on %I for select to authenticated using (is_admin())', tbl);
    end loop;
end $$;

drop policy if exists doer_sees_own on tasks;
create policy doer_sees_own on tasks for select to authenticated
    using (doer_email = fms_email() or is_admin());
drop policy if exists super_admin_all on tasks;
create policy super_admin_all on tasks for all to authenticated
    using (is_admin()) with check (is_admin());

drop policy if exists own_or_admin on edit_requests;
create policy own_or_admin on edit_requests for select to authenticated
    using (requested_by = fms_email() or is_admin());

-- Website (anon key, not logged in) can read nothing
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Only these functions are callable from the website
revoke execute on all functions in schema public from public;
do $$
begin
    execute 'revoke execute on all functions in schema public from anon, authenticated';
exception when undefined_object then null;
end $$;
grant execute on function
    fms_email(), fms_role(), is_admin(), cfg(text), suggest_po_number(), task_balance(bigint),
    add_working_hours(timestamptz, numeric), working_hours_between(timestamptz, timestamptz),
    create_po(jsonb), complete_task(bigint, jsonb, text), split_task(bigint, jsonb, jsonb, text),
    assign_clients(bigint, jsonb, text), reject_task(bigint, text),
    hold_work(text, text, text), resume_work(text, text), cancel_work(text, text, text),
    reassign_task(bigint, text), reassign_step(text, text, boolean),
    edit_task_data(bigint, jsonb, text), decide_edit(bigint, boolean),
    get_task_detail(bigint), po_progress(text)
to authenticated;

-- =====================================================================
-- 10. REALTIME (in-app toast) + FILE STORAGE (PDF uploads)
-- =====================================================================
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tasks') then
        execute 'alter publication supabase_realtime add table tasks';
    end if;
end $$;

do $$
begin
    if exists (select 1 from pg_namespace where nspname = 'storage') then
        insert into storage.buckets (id, name, public) values ('fms-files', 'fms-files', false)
        on conflict (id) do nothing;
        execute 'drop policy if exists fms_files_read on storage.objects';
        execute 'create policy fms_files_read on storage.objects for select to authenticated using (bucket_id = ''fms-files'')';
        execute 'drop policy if exists fms_files_upload on storage.objects';
        execute 'create policy fms_files_upload on storage.objects for insert to authenticated with check (bucket_id = ''fms-files'')';
    end if;
end $$;

-- Done. Next: run 02_cron.sql (reminders + email sending).
