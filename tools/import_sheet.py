#!/usr/bin/env python3
"""
Convert the Google Sheet "FUTURE ORDER LOOKER" (downloaded as .xlsx) into SQL
for Supabase (history import).

    pip install openpyxl
    python tools/import_sheet.py FUTURE_ORDER_LOOKER.xlsx supabase/03_import_history.sql

Then paste the .sql file into Supabase SQL Editor and Run (once).

Sheet → database mapping
    FMS      (PO + S1)            → purchase_orders + S1 task
    FMS 2    (S2..S7, WO lots)    → lots stage WO   (UNIQUE NO.  → legacy_key)
    FMS 3    (S8..S10, BO lots)   → lots stage BO   (REFERENCE NO = FMS 2 unique no.)
    FMS 4    (S11, FG lots)       → lots stage FG   (REFERENCE NO = FMS 3 unique no.)
    FMS 5    (assigned to client) → client_assignments (REFERENCE NO = FMS 4 unique no.)

Split steps (S1, S7, S10) and S11 are DONE only when the balance is 0,
otherwise PENDING — same rule as the new system.
"""
import datetime as dt
import json
import sys
from collections import defaultdict

import openpyxl

IST = "+05:30"
warnings = []


def warn(msg):
    warnings.append(msg)


def ts(v):
    """Sheet datetime (IST, naive) → SQL literal"""
    if isinstance(v, dt.datetime):
        return f"'{v.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}{IST}'"
    return "null"


def lit(v):
    if v is None or v == "":
        return "null"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def key(v):
    """Unique no. (number or float) → text key"""
    if v is None or v == "":
        return None
    try:
        return str(int(float(v)))
    except (TypeError, ValueError):
        return None


def qty(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f > 0 and f == int(f) else None


def label(v):
    """CLIENT NAME column: dates / excel serials become 'AUG 2026'"""
    if isinstance(v, dt.datetime):
        return v.strftime("%b %Y").upper()
    if isinstance(v, (int, float)) and 30000 < v < 80000:
        return (dt.datetime(1899, 12, 30) + dt.timedelta(days=v)).strftime("%b %Y").upper()
    return str(v).strip() if v not in (None, "") else None


def text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v).strip()


def rows(ws, first=7):
    for r in ws.iter_rows(min_row=first, values_only=True):
        if r and len(r) > 1 and r[1]:
            yield r


def main(xlsx, out_path):
    wb = openpyxl.load_workbook(xlsx, data_only=True)
    sheet = {ws.title.strip(): ws for ws in wb.worksheets}

    pos, lots, tasks, assigns = {}, {}, [], []
    used_legacy = set()

    def add_task(po, lot, step, status, planned, actual, start):
        if planned is None and actual is None:
            return
        tasks.append(dict(po=po, lot=lot, step=step, status=status,
                          planned=planned or actual, actual=actual if status == "DONE" else None,
                          created=start or planned or actual))

    def new_lot(po, parent, stage, q, legacy, created):
        siblings = [l for l in lots.values() if l["po"] == po and l["parent"] == parent]
        seq = len(siblings) + 1
        lk = f"{po}-W{seq}" if parent is None else f"{parent}-{stage[0]}{seq}"
        if legacy in used_legacy:
            warn(f"duplicate unique no. {legacy} ({lk}) — stored without legacy key")
            legacy = None
        if legacy:
            used_legacy.add(legacy)
        lots[lk] = dict(key=lk, po=po, parent=parent, stage=stage, seq=seq, qty=q, legacy=legacy,
                        created=created, status="ACTIVE", completed=None)
        return lk

    # ---------- FMS: purchase orders ----------
    for r in rows(sheet["FMS"]):
        po = text(r[1]).upper()
        q = qty(r[5])
        if not q:
            warn(f"FMS {po}: qty '{r[5]}' invalid — skipped")
            continue
        if po in pos:
            warn(f"FMS {po}: duplicate PO row — skipped")
            continue
        pos[po] = dict(po=po, label=label(r[2]), series=text(r[3]).upper() or "-", model=text(r[4]) or "-",
                       qty=q, price=r[7] if isinstance(r[7], (int, float)) else None,
                       created=r[0], s1_planned=r[8], s1_actual=r[9], status="ACTIVE")

    # ---------- FMS 2: WO lots + S2..S7 ----------
    wo_by_legacy = {}
    wo_rows = sorted(rows(sheet["FMS 2"]), key=lambda r: r[0] if isinstance(r[0], dt.datetime) else dt.datetime.max)
    for r in wo_rows:
        po = text(r[1]).upper()
        q = qty(r[6])
        if po not in pos:
            ordered = qty(r[5])
            if not ordered:
                warn(f"FMS 2 {po}: PO not in FMS and ordered qty '{r[5]}' invalid — skipped")
                continue
            warn(f"FMS 2 {po}: PO row missing in FMS tab — PO created from FMS 2 data")
            pos[po] = dict(po=po, label=label(r[2]), series=text(r[3]).upper() or "-", model=text(r[4]) or "-",
                           qty=ordered, price=None, created=r[0], s1_planned=None, s1_actual=r[0], status="ACTIVE")
        if not q:
            warn(f"FMS 2 {po}: qty '{r[6]}' invalid — skipped")
            continue
        legacy = key(r[8])
        lk = new_lot(po, None, "WO", q, legacy, r[0])
        if legacy:
            wo_by_legacy[legacy] = lk
        lots[lk]["s7"] = (r[29], r[30])
        start = r[0]
        for step, p, a in (("S2", 9, 10), ("S3", 13, 14), ("S4", 17, 18), ("S5", 21, 22), ("S6", 25, 26)):
            planned, actual = r[p], r[a]
            if isinstance(actual, dt.datetime):
                add_task(po, lk, step, "DONE", planned, actual, start)
                start = actual
            elif isinstance(planned, dt.datetime):
                add_task(po, lk, step, "PENDING", planned, None, start)
                later = [s for s, aa in (("S3", 14), ("S4", 18), ("S5", 22), ("S6", 26), ("S7", 30)) if aa > a and isinstance(r[aa], dt.datetime)]
                if later:
                    warn(f"{lk} ({legacy}): {step} pending but {', '.join(later)} already done in sheet — kept {step} as the open step")
                break
            else:
                break
        lots[lk]["s6_done_at"] = start if any(t["lot"] == lk and t["step"] == "S6" and t["status"] == "DONE" for t in tasks) else None

    # ---------- FMS 3: BO lots + S8, S9, S10 ----------
    bo_by_legacy = {}
    for r in sorted(rows(sheet["FMS 3"]), key=lambda r: r[0] if isinstance(r[0], dt.datetime) else dt.datetime.max):
        ref = key(r[8])
        parent = wo_by_legacy.get(ref)
        q = qty(r[7])
        if not parent:
            warn(f"FMS 3 {text(r[1])}: reference {ref} not found in FMS 2 — skipped")
            continue
        if not q:
            warn(f"FMS 3 {parent}: qty '{r[7]}' invalid — skipped")
            continue
        legacy = key(r[9])
        lk = new_lot(lots[parent]["po"], parent, "BO", q, legacy, r[0])
        if legacy:
            bo_by_legacy[legacy] = lk
        lots[lk]["s10"] = (r[19], r[20])
        start = r[0]
        for step, p, a in (("S8", 10, 11), ("S9", 15, 16)):
            planned, actual = r[p], r[a]
            if isinstance(actual, dt.datetime):
                add_task(lots[lk]["po"], lk, step, "DONE", planned, actual, start)
                start = actual
            elif isinstance(planned, dt.datetime):
                add_task(lots[lk]["po"], lk, step, "PENDING", planned, None, start)
                break
            else:
                break
        lots[lk]["s9_done"] = any(t["lot"] == lk and t["step"] == "S9" and t["status"] == "DONE" for t in tasks)

    # ---------- FMS 4: FG lots + S11 ----------
    fg_by_legacy = {}
    for r in sorted(rows(sheet["FMS 4"]), key=lambda r: r[0] if isinstance(r[0], dt.datetime) else dt.datetime.max):
        ref = key(r[7])
        parent = bo_by_legacy.get(ref)
        q = qty(r[8])
        if not parent:
            warn(f"FMS 4 {text(r[1])}: reference {ref} not found in FMS 3 — skipped")
            continue
        if not q:
            warn(f"FMS 4 {parent}: ready qty '{r[8]}' invalid — row skipped")
            continue
        legacy = key(r[9])
        lk = new_lot(lots[parent]["po"], parent, "FG", q, legacy, r[0])
        if legacy:
            fg_by_legacy[legacy] = lk
        lots[lk]["s11"] = (r[11], r[12])

    # ---------- FMS 5: client assignments ----------
    for r in rows(sheet["FMS 5"]):
        ref = key(r[5])
        lot = fg_by_legacy.get(ref)
        q = qty(r[6])
        client = text(r[8]).upper()
        if not lot:
            warn(f"FMS 5 {text(r[1])} → {client}: reference {ref} not found in FMS 4 — skipped")
            continue
        if not q or not client:
            warn(f"FMS 5 {lot}: qty '{r[6]}' / client '{client}' invalid — skipped")
            continue
        assigns.append(dict(po=lots[lot]["po"], lot=lot, client=client, qty=q, created=r[0]))

    # ---------- split / assign steps from balances ----------
    def children(parent_key, po=None):
        if parent_key is None:
            return [l for l in lots.values() if l["po"] == po and l["parent"] is None]
        return [l for l in lots.values() if l["parent"] == parent_key]

    def split_task(po, lot_key, step, total, kids, planned, actual, start):
        used = sum(k["qty"] for k in kids)
        last = max((k["created"] for k in kids if isinstance(k["created"], dt.datetime)), default=None)
        if used > total:
            warn(f"{lot_key or po} {step}: {used} allocated but only {total} available (sheet data) — marked done")
        if kids and used >= total:
            done_at = actual if isinstance(actual, dt.datetime) else last
            add_task(po, lot_key, step, "DONE", planned if isinstance(planned, dt.datetime) else done_at, done_at, start)
            return True
        if isinstance(planned, dt.datetime) or kids:
            add_task(po, lot_key, step, "PENDING", planned if isinstance(planned, dt.datetime) else last, None, start)
        return False

    for po, p in pos.items():
        if split_task(po, None, "S1", p["qty"], children(None, po), p["s1_planned"], p["s1_actual"], p["created"]):
            p["s1_done"] = True

    for lk, l in list(lots.items()):
        if l["stage"] == "WO" and (l.get("s6_done_at") or children(lk)):
            planned, actual = l["s7"]
            if split_task(l["po"], lk, "S7", l["qty"], children(lk), planned, actual, l.get("s6_done_at")):
                l["status"] = "COMPLETED"
        elif l["stage"] == "BO" and (l.get("s9_done") or children(lk)):
            planned, actual = l["s10"]
            if split_task(l["po"], lk, "S10", l["qty"], children(lk), planned, actual, None):
                l["status"] = "COMPLETED"
        elif l["stage"] == "FG":
            planned, actual = l["s11"]
            got = sum(a["qty"] for a in assigns if a["lot"] == lk)
            if got > l["qty"]:
                warn(f"{lk}: {got} assigned to clients but FG qty is {l['qty']} (sheet data)")
            if got >= l["qty"]:
                last = max((a["created"] for a in assigns if a["lot"] == lk), default=None)
                add_task(l["po"], lk, "S11", "DONE", planned, actual if isinstance(actual, dt.datetime) else last, l["created"])
                l["status"] = "COMPLETED"
            else:
                add_task(l["po"], lk, "S11", "PENDING", planned if isinstance(planned, dt.datetime) else l["created"], None, l["created"])

    for po, p in pos.items():
        mine = [l for l in lots.values() if l["po"] == po]
        if p.get("s1_done") and mine and all(l["status"] == "COMPLETED" for l in mine):
            p["status"] = "COMPLETED"

    # ---------- write SQL ----------
    out = []
    w = out.append
    w("-- OMEX FMS — history imported from Google Sheet")
    w(f"-- Generated {dt.datetime.now():%Y-%m-%d %H:%M} from {xlsx.split('/')[-1]}")
    w(f"-- {len(pos)} POs, {len(lots)} lots, {len(tasks)} tasks, {len(assigns)} client assignments")
    w("-- Run ONCE in Supabase SQL Editor, after 01_setup.sql.\n")
    w("begin;")
    w("do $$ begin if exists (select 1 from purchase_orders where is_legacy) then "
      "raise exception 'History already imported — nothing done.'; end if; end $$;\n")

    w("insert into purchase_orders (po_number, lot_label, series, model_no, total_qty, unit_price, status, created_by, created_at, completed_at, is_legacy) values")
    w(",\n".join(
        f"  ({lit(p['po'])}, {lit(p['label'])}, {lit(p['series'])}, {lit(p['model'])}, {p['qty']}, {lit(p['price'])}, "
        f"'{p['status']}', 'sheet-import', {ts(p['created'])}, {'now()' if p['status'] == 'COMPLETED' else 'null'}, true)"
        for p in pos.values()) + ";\n")

    order = {"WO": 0, "BO": 1, "FG": 2}
    w("insert into lots (lot_key, legacy_key, po_number, parent_lot_key, stage, seq, qty, status, created_by, created_at, completed_at) values")
    w(",\n".join(
        f"  ({lit(l['key'])}, {lit(l['legacy'])}, {lit(l['po'])}, {lit(l['parent'])}, '{l['stage']}', {l['seq']}, {l['qty']}, "
        f"'{l['status']}', 'sheet-import', {ts(l['created'])}, {'now()' if l['status'] == 'COMPLETED' else 'null'})"
        for l in sorted(lots.values(), key=lambda l: (order[l["stage"]], l["key"]))) + ";\n")

    w("insert into tasks (po_number, lot_key, step_code, doer_email, status, planned_at, actual_at, data, done_by, created_at) values")
    w(",\n".join(
        f"  ({lit(t['po'])}, {lit(t['lot'])}, '{t['step']}', (select doer_email from steps where step_code = '{t['step']}'), "
        f"'{t['status']}', {ts(t['planned'])}, {ts(t['actual'])}, '{json.dumps({'source': 'sheet'})}', "
        f"{'null' if t['status'] != 'DONE' else lit('sheet-import')}, {ts(t['created'])})"
        for t in tasks) + ";\n")

    if assigns:
        w("insert into client_assignments (po_number, fg_lot_key, client_name, qty, created_by, created_at) values")
        w(",\n".join(
            f"  ({lit(a['po'])}, {lit(a['lot'])}, {lit(a['client'])}, {a['qty']}, 'sheet-import', {ts(a['created'])})"
            for a in assigns) + ";\n")

    w("-- link assignments to their S11 task")
    w("update client_assignments a set task_id = t.id from tasks t "
      "where a.created_by = 'sheet-import' and t.lot_key = a.fg_lot_key and t.step_code = 'S11';\n")
    w("-- old overdue tasks: no flood of reminder emails, they appear in the morning summary only")
    w("insert into reminder_log (task_id, kind) select id, k from tasks, unnest(array['DUE_SOON','DUE_NOW','ESCALATION']) k "
      "where status = 'PENDING' and planned_at < now() and data ->> 'source' = 'sheet' on conflict do nothing;\n")
    w("insert into audit_log (actor_email, action, entity_type, entity_id, after_state) values "
      f"('sheet-import', 'IMPORT', 'SYSTEM', 'google-sheet', '{json.dumps({'pos': len(pos), 'lots': len(lots), 'tasks': len(tasks), 'assignments': len(assigns)})}');")
    w("commit;\n")
    if warnings:
        w("-- ===== Data warnings (check these in the sheet) =====")
        for m in warnings:
            w("-- " + m.replace("\n", " "))

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")

    pending = sum(1 for t in tasks if t["status"] == "PENDING")
    print(f"POs {len(pos)}, lots {len(lots)}, tasks {len(tasks)} ({pending} pending), assignments {len(assigns)}")
    print(f"{len(warnings)} warnings:")
    for m in warnings:
        print("  -", m)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python tools/import_sheet.py <sheet.xlsx> <out.sql>")
    main(sys.argv[1], sys.argv[2])
