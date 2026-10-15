-- =====================================================================
--  OMEX FMS — reminders + email sending schedule
--  Run AFTER 01_setup.sql and AFTER deploying the `send-emails`
--  Edge Function (see SETUP_GUIDE.md, step 5).
--
--  Before running, replace the two values marked  <<< CHANGE >>>
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Private settings: RLS on and no policies → website users cannot read this.
create table if not exists private_config (
    key   text primary key,
    value text not null
);
alter table private_config enable row level security;
revoke all on private_config from anon, authenticated;

insert into private_config (key, value) values
    -- Your project URL + /functions/v1/send-emails
    ('email_function_url', 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-emails'),  -- <<< CHANGE >>>
    -- Any long random text. Put the SAME text in the Edge Function secret CRON_SECRET.
    ('cron_secret',        'CHANGE-ME-to-a-long-random-text')                                  -- <<< CHANGE >>>
on conflict (key) do update set value = excluded.value;

-- Calls the Edge Function only when there is something to send
create or replace function trigger_email_sender() returns void
language plpgsql security definer set search_path = public as $$
declare
    v_url    text := (select value from private_config where key = 'email_function_url');
    v_secret text := (select value from private_config where key = 'cron_secret');
begin
    if not exists (select 1 from notifications where status = 'PENDING') then
        return;
    end if;
    perform net.http_post(
        url     := v_url,
        body    := '{}'::jsonb,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
        timeout_milliseconds := 30000
    );
end;
$$;
revoke execute on function trigger_email_sender() from public;
do $$ begin
    execute 'revoke execute on function trigger_email_sender() from anon, authenticated';
exception when undefined_object then null;
end $$;

-- Every 15 minutes: queue reminders (function itself skips nights / Sundays / holidays)
select cron.schedule('fms-reminders', '*/15 * * * *', $$select public.queue_reminders()$$);

-- Every minute: send queued emails (new task emails reach the doer within ~1 minute)
select cron.schedule('fms-send-emails', '* * * * *', $$select public.trigger_email_sender()$$);

-- Every Sunday: clean old cron history + old sent notifications (keeps the free 500 MB tidy)
select cron.schedule('fms-cleanup', '0 3 * * 0', $$
    delete from cron.job_run_details where end_time < now() - interval '7 days';
    delete from net._http_response where created < now() - interval '7 days';
    delete from public.notifications where status in ('SENT', 'SKIPPED') and created_at < now() - interval '90 days';
$$);

-- Check: select jobname, schedule, active from cron.job;
-- Logs:  select * from cron.job_run_details order by start_time desc limit 20;
