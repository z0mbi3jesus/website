create table public.contact_messages (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    name text not null check (char_length(btrim(name)) between 1 and 120),
    email text not null check (char_length(email) between 3 and 320),
    message text not null check (char_length(btrim(message)) between 1 and 5000),
    email_status text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
    email_sent_at timestamptz
);

create index contact_messages_created_at_idx
    on public.contact_messages (created_at desc);

alter table public.contact_messages enable row level security;

revoke all on table public.contact_messages from anon, authenticated;
grant all on table public.contact_messages to service_role;

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
    'contact-messages-retention',
    '0 3 * * *',
    $$delete from public.contact_messages where created_at < now() - interval '12 months'$$
);