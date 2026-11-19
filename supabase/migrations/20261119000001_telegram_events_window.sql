-- Events apply only inside their window (telegram-ingest/gating.ts offers an event to a post only when the post's
-- time is between active_from and active_to), and only a new event re-gates posts: the ones in its window. Before,
-- any change to an event's description or active_from re-gated every post since active_from, although they had
-- already been gated with the event in the list (2026-11-19: moving anthropic-ipo's start reset 1,005 posts).
-- To re-tag after editing an event, reset the posts yourself (README → Telegram gate: useful SQL).
--
-- active_from is required, by default 7 days before the event is added: a null start meant two things (the reset
-- covered the last 7 days, tagging had no start at all).

update public.telegram_events set active_from = created_at - interval '7 days' where active_from is null;
alter table public.telegram_events
  alter column active_from set default now() - interval '7 days',
  alter column active_from set not null;

create or replace function public.telegram_events_regate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.telegram_messages set gated_at = null
  where gated_at is not null
    and ts >= new.active_from
    and (new.active_to is null or ts < new.active_to);
  return null;
end
$$;

drop trigger if exists telegram_events_regate on public.telegram_events;
create trigger telegram_events_regate
  after insert on public.telegram_events
  for each row execute function public.telegram_events_regate();
