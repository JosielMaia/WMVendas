-- Multiempresa: identidade dos usuários e personalização básica da loja
alter table public.wm_sessions add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.wm_sessions add column if not exists member_id uuid references public.wm_tenant_members(id) on delete cascade;
alter table public.wm_sessions add column if not exists role text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='wm_sessions_role_check') then
    alter table public.wm_sessions add constraint wm_sessions_role_check
      check (role is null or role in ('owner','admin','seller','viewer'));
  end if;
end $$;

create index if not exists wm_sessions_user_idx on public.wm_sessions(user_id);

alter table public.wm_store_settings add column if not exists logo_url text;
alter table public.wm_store_settings add column if not exists primary_color text not null default '#7b2448';
alter table public.wm_store_settings add column if not exists accent_color text not null default '#d6ad60';
alter table public.wm_store_settings add column if not exists slogan text not null default 'Estoque, vendas e cobranças na palma da mão';

create table if not exists public.wm_signup_attempts(
  id bigint generated always as identity primary key,
  client_key text not null,
  succeeded boolean not null default false,
  attempted_at timestamptz not null default now()
);
alter table public.wm_signup_attempts enable row level security;
create index if not exists wm_signup_attempts_client_time_idx on public.wm_signup_attempts(client_key,attempted_at desc);
