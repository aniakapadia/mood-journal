-- Rate limiting for the public /api/send-login-link endpoint.
--
-- Sign-up is open to anyone, so the send endpoint is reachable by the whole
-- internet. Without this, one script could burn the Resend monthly quota and
-- fill auth.users with junk accounts. The in-process throttle in the API
-- function only protects a single warm serverless instance; this is shared
-- across all of them.

create table if not exists public.rate_limit (
  key          text primary key,
  window_start timestamptz not null default now(),
  count        integer     not null default 0
);

-- Records a hit and reports whether it is still under the limit.
-- SECURITY DEFINER so it can touch the table without granting anyone access
-- to the table itself.
-- p_window is seconds rather than an interval: PostgREST maps JSON numbers to
-- integer cleanly, whereas an interval argument has to be sent as text.
create or replace function public.rate_hit(p_key text, p_limit integer, p_window integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c integer;
  w interval := make_interval(secs => p_window);
begin
  insert into public.rate_limit (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set count = case
          when rate_limit.window_start < now() - w then 1
          else rate_limit.count + 1
        end,
        window_start = case
          when rate_limit.window_start < now() - w then now()
          else rate_limit.window_start
        end
  returning count into c;

  return c <= p_limit;
end
$$;

-- Nobody reaches the table or the function except the server-side key.
revoke all on public.rate_limit from anon, authenticated;
revoke all on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_hit(text, integer, integer) to service_role;

alter table public.rate_limit enable row level security;

-- PostgREST caches the schema; without this the new function is invisible.
notify pgrst, 'reload schema';

-- Housekeeping: drop rows whose window closed long ago.
create index if not exists rate_limit_window_idx on public.rate_limit (window_start);
