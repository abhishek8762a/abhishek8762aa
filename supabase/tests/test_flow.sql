-- Local test of the workflow (plain Postgres 15+). NOT for Supabase.
-- Usage: createdb fms_test; create roles anon/authenticated; run 01_setup.sql; then this file.
\set ON_ERROR_STOP 1
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;

create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
begin
    perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
end $$;

create or replace function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
    if not coalesce(p_ok, false) then raise exception 'TEST FAILED: %', p_msg; end if;
    raise notice 'ok  %', p_msg;
end $$;

-- ---------- 1. Working-hours TAT matches the Google Sheet ----------
-- PO/26/08/004: S3 done 18 Aug 15:36:07.919 → S4 (8 h) planned 19 Aug 15:06:07.919
select pg_temp.check(add_working_hours('2026-08-18 15:36:07.919+05:30', 8) = '2026-08-19 15:06:07.919+05:30', 'S4 8h matches sheet');
-- PO/26/08/004 split 18 Aug 15:34:14.592 → S2 (16 h) planned 20 Aug 14:34:14.592
select pg_temp.check(add_working_hours('2026-08-18 15:34:14.592+05:30', 16) = '2026-08-20 14:34:14.592+05:30', 'S2 16h matches sheet');
-- S4 done 18 Aug 15:36:14 → S5 (240 h) planned 21 Sep 09:06 (Sundays skipped)
select pg_temp.check(date_trunc('minute', add_working_hours('2026-08-18 15:36:08.064+05:30', 240)) = '2026-09-21 09:06+05:30', 'S5 240h matches sheet');
-- PO/26/09/036: S5 done 09 Oct 18:31 (after closing) → S6 (56 h) planned 17 Oct 13:59/14:00
select pg_temp.check(add_working_hours('2026-10-09 18:31:00+05:30', 56) = '2026-10-17 14:00+05:30', 'after-hours start rolls to next day');
-- Saturday 17:00 + 1h → Monday 09:30 (Sunday off)
select pg_temp.check(add_working_hours('2026-10-17 17:00+05:30', 1) = '2026-10-19 09:30+05:30', 'Sunday skipped');
insert into holidays values ('2026-10-19', 'Test holiday');
select pg_temp.check(add_working_hours('2026-10-17 17:00+05:30', 1) = '2026-10-20 09:30+05:30', 'holiday skipped');
delete from holidays;
select pg_temp.check(working_hours_between('2026-10-17 17:00+05:30', '2026-10-19 09:30+05:30') = 1, 'working_hours_between across Sunday');

-- ---------- 2. Create PO (permissions) ----------
select pg_temp.login('dp2@omexgears.com');
do $$ begin
    perform create_po('{"po_number":"PO/26/10/100","series":"DEX","model_no":"140","total_qty":10}');
    raise exception 'should have failed';
exception when others then
    if sqlerrm like 'should%' then raise; end if;
    raise notice 'ok  doer cannot create PO (%)', sqlerrm;
end $$;

select pg_temp.login('dp6@omexgears.com');
select create_po('{"po_number":"po/26/10/100","lot_label":"NOV 1st lot","series":"dex","model_no":"140","total_qty":10,"unit_price":"70000"}');
select pg_temp.check((select count(*) = 1 from tasks where po_number = 'PO/26/10/100' and step_code = 'S1' and status = 'PENDING'), 'S1 task created for Neha');
select pg_temp.check((select count(*) = 1 from notifications where kind = 'NEW_TASK' and recipient_email = 'dp6@omexgears.com'), 'S1 email queued');
do $$ begin
    perform create_po('{"po_number":"PO/26/10/100","series":"DEX","model_no":"140","total_qty":10}');
    raise exception 'should have failed';
exception when others then
    if sqlerrm like 'should%' then raise; end if;
    raise notice 'ok  duplicate PO blocked (%)', sqlerrm;
end $$;
select pg_temp.check(suggest_po_number() like 'PO/__/__/101', 'next PO number suggested');

-- ---------- 3. S1 split: partial, stays pending until balance 0 ----------
select split_task((select id from tasks where po_number = 'PO/26/10/100' and step_code = 'S1'),
                  '[{"qty":6,"planned_date":"2026-11-01"}]');
select pg_temp.check((select status = 'PENDING' from tasks where po_number = 'PO/26/10/100' and step_code = 'S1'), 'S1 still pending with balance 4');
select pg_temp.check(task_balance((select id from tasks where po_number = 'PO/26/10/100' and step_code = 'S1')) = 4, 'balance = 4');
do $$ begin
    perform split_task((select id from tasks where po_number = 'PO/26/10/100' and step_code = 'S1'), '[{"qty":5}]');
    raise exception 'should have failed';
exception when others then
    if sqlerrm like 'should%' then raise; end if;
    raise notice 'ok  over-allocation blocked (%)', sqlerrm;
end $$;
select split_task((select id from tasks where po_number = 'PO/26/10/100' and step_code = 'S1'),
                  '[{"qty":3},{"qty":1,"priority":"URGENT"}]');
select pg_temp.check((select status = 'DONE' from tasks where po_number = 'PO/26/10/100' and step_code = 'S1'), 'S1 done at balance 0');
select pg_temp.check((select array_agg(lot_key order by lot_key) = '{PO/26/10/100-W1,PO/26/10/100-W2,PO/26/10/100-W3}' from lots where po_number = 'PO/26/10/100'), 'lot keys W1..W3');
select pg_temp.check((select count(*) = 3 from tasks where step_code = 'S2' and status = 'PENDING' and doer_email = 'dp2@omexgears.com'), '3 S2 tasks for Aastha');

-- ---------- 4. RLS: doer sees only own tasks ----------
set role authenticated;
select pg_temp.login('dp10@omexgears.com');
select pg_temp.check((select count(*) = 0 from tasks), 'Rajinder sees no tasks yet');
select pg_temp.login('dp2@omexgears.com');
select pg_temp.check((select count(*) = 3 from tasks), 'Aastha sees her 3 tasks');
select pg_temp.login('dp9@omexgears.com');
select pg_temp.check((select count(*) = 4 from tasks), 'Admin sees all 4');
select pg_temp.login('dp2@omexgears.com');
do $$ begin
    update tasks set status = 'DONE' where step_code = 'S2';
    if found then raise exception 'should have failed'; end if;
    raise notice 'ok  doer cannot update tasks directly';
end $$;
select pg_temp.check((select count(*) = 0 from notifications), 'doer cannot read notifications');
reset role;

-- ---------- 5. Walk W1 through S2..S6, reject at S3 ----------
select pg_temp.login('dp2@omexgears.com');
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S2' and status = 'PENDING'), '{"can_proceed":"Yes"}');
select pg_temp.login('dp10@omexgears.com');
do $$ begin
    perform complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S3' and status = 'PENDING'));
    raise exception 'should have failed';
exception when others then
    if sqlerrm like 'should%' then raise; end if;
    raise notice 'ok  other doer cannot complete (%)', sqlerrm;
end $$;
select pg_temp.login('dp2@omexgears.com');
select reject_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S3' and status = 'PENDING'), 'Material list galat hai');
select pg_temp.check((select attempt_no = 2 from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S2' and status = 'PENDING'), 'S2 reopened with attempt 2');
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S2' and status = 'PENDING'), '{"can_proceed":"Yes"}');
select pg_temp.check((select attempt_no = 2 from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S3' and status = 'PENDING'), 'S3 comes back as attempt 2');
do $$ begin
    perform reject_task((select id from tasks where lot_key = 'PO/26/10/100-W2' and step_code = 'S2'), 'x');
    raise exception 'should have failed';
exception when others then
    if sqlerrm like 'should%' then raise; end if;
    raise notice 'ok  reject at first step blocked (%)', sqlerrm;
end $$;
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S3' and status = 'PENDING'));
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S4' and status = 'PENDING'),
                     '{"vendor_pos":[{"vendor":"A","po_no":"V1"},{"vendor":"B","po_no":"V2"},{"vendor":"C","po_no":"V3"}]}');
select pg_temp.check((select count(*) = 1 from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S5'), 'multiple vendor POs → one S5 task');
select pg_temp.login('dp10@omexgears.com');
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S5' and status = 'PENDING'));
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S6' and status = 'PENDING'));
select pg_temp.check((select doer_email = 'dp6@omexgears.com' from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S7'), 'S7 to Neha');

-- ---------- 6. S7 split to BO lots, S10 split to FG, S11 assign ----------
select pg_temp.login('dp6@omexgears.com');
select split_task((select id from tasks where lot_key = 'PO/26/10/100-W1' and step_code = 'S7'), '[{"qty":4},{"qty":2}]', '{"assembly_date":"2026-11-05"}');
select pg_temp.check((select status = 'COMPLETED' from lots where lot_key = 'PO/26/10/100-W1'), 'WO lot completed after S7 full split');
select pg_temp.check((select count(*) = 2 from tasks where step_code = 'S8' and lot_key like 'PO/26/10/100-W1-B%'), 'two S8 tasks');
select pg_temp.login('dp2@omexgears.com');
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S8'));
select pg_temp.login('dp10@omexgears.com');
select complete_task((select id from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S9'));
select split_task((select id from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S10'), '[{"qty":3}]');
select pg_temp.check((select status = 'PENDING' from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S10'), 'S10 pending with 1 left');
select split_task((select id from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S10'), '[{"qty":1}]');
select pg_temp.login('dp6@omexgears.com');
select assign_clients((select id from tasks where lot_key = 'PO/26/10/100-W1-B1-F1' and step_code = 'S11'),
                      '[{"client_name":"dseps","qty":1,"invoice_no":"INV-1"},{"client_name":"SS ENGG","qty":2}]');
select pg_temp.check((select status = 'COMPLETED' from lots where lot_key = 'PO/26/10/100-W1-B1-F1'), 'FG lot completed after full assignment');
select pg_temp.check((select sum(qty) = 3 from client_assignments where po_number = 'PO/26/10/100'), 'client assignments saved');

-- ---------- 7. Edit after submit ----------
select pg_temp.login('dp2@omexgears.com');
select pg_temp.check((select edit_task_data((select id from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S8'), '{"note":"fixed"}') ->> 'status') = 'UPDATED', 'edit within 1 hour applied');
update tasks set actual_at = now() - interval '2 hours' where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S8';
select pg_temp.check((select edit_task_data((select id from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S8'), '{"note":"late"}', 'typo') ->> 'status') = 'REQUESTED', 'late edit needs approval');
select pg_temp.login('dp9@omexgears.com');
select decide_edit((select max(id) from edit_requests), true);
select pg_temp.check((select data ->> 'note' = 'late' from tasks where lot_key = 'PO/26/10/100-W1-B1' and step_code = 'S8'), 'admin approved edit');

-- ---------- 8. Hold / resume shifts due date; cancel ----------
select hold_work(null, 'PO/26/10/100-W2', 'client dispute');
select pg_temp.login('dp2@omexgears.com');
do $$ begin
    perform complete_task((select id from tasks where lot_key = 'PO/26/10/100-W2' and step_code = 'S2'));
    raise exception 'should have failed';
exception when others then
    if sqlerrm like 'should%' then raise; end if;
    raise notice 'ok  held lot cannot be done (%)', sqlerrm;
end $$;
select pg_temp.login('dp9@omexgears.com');
update lots set hold_started_at = hold_started_at - interval '3 days' where lot_key = 'PO/26/10/100-W2';
create temp table before_resume as select planned_at from tasks where lot_key = 'PO/26/10/100-W2' and status = 'PENDING';
select resume_work(null, 'PO/26/10/100-W2');
select pg_temp.check((select t.planned_at > b.planned_at from tasks t, before_resume b where t.lot_key = 'PO/26/10/100-W2' and t.status = 'PENDING'), 'resume pushes due date forward');

select cancel_work(null, 'PO/26/10/100-W3', 'client ne cancel kiya');
select pg_temp.check((select status = 'CANCELLED' from tasks where lot_key = 'PO/26/10/100-W3'), 'cancel removes pending task');

-- ---------- 9. Reassign ----------
insert into app_users (email, full_name) values ('dp11@omexgears.com', 'TEMP');
select reassign_step('S5', 'dp11@omexgears.com', true);
select pg_temp.check((select doer_email = 'dp11@omexgears.com' from steps where step_code = 'S5'), 'S5 reassigned');

-- ---------- 10. Reminders ----------
delete from notifications;
-- make one task overdue by 2 working days and one due in 3 working hours
update tasks set planned_at = add_working_hours(now() - interval '5 days', 1)
 where id = (select id from tasks where lot_key = 'PO/26/10/100-W1-B2' and step_code = 'S8');
select queue_reminders();
select queue_reminders();   -- second run must not duplicate
select pg_temp.check(
    case when is_working_time(now())
         then (select count(*) = 1 from notifications where kind = 'DUE_NOW') and (select count(*) = 1 from notifications where kind = 'ESCALATION' and cc_email = 'dp9@omexgears.com')
         else (select count(*) = 0 from notifications) end,
    'reminders queued once (or skipped outside working hours)');

-- ---------- 11. PO completes when everything is finished ----------
select pg_temp.check((select status = 'ACTIVE' from purchase_orders where po_number = 'PO/26/10/100'), 'PO still active');
select cancel_work('PO/26/10/100', null, 'test end');
select pg_temp.check((select count(*) = 0 from tasks where po_number = 'PO/26/10/100' and status = 'PENDING'), 'PO cancel clears pending');

select pg_temp.login('dp6@omexgears.com');
select pg_temp.check(jsonb_array_length(po_progress()) = 1, 'po_progress works for sales');
select pg_temp.check((get_task_detail((select id from tasks where lot_key = 'PO/26/10/100-W1-B1-F1')) -> 'history') is not null, 'task detail returns history');

\echo ALL TESTS PASSED
