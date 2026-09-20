-- Administração comercial do SaaS e controle manual de mensalidades.
alter table public.wm_tenants add column if not exists monthly_price numeric(12,2) not null default 0 check (monthly_price >= 0);
alter table public.wm_tenants add column if not exists subscription_due_at timestamptz;
alter table public.wm_tenants add column if not exists grace_until timestamptz;
alter table public.wm_tenants add column if not exists blocked_at timestamptz;
alter table public.wm_tenants add column if not exists billing_notes text not null default '';

create index if not exists wm_tenants_subscription_status_due_idx
  on public.wm_tenants(subscription_status, subscription_due_at);
create index if not exists wm_sessions_member_id_idx on public.wm_sessions(member_id);
create index if not exists wm_tenant_members_created_by_idx on public.wm_tenant_members(created_by);

alter table public.wm_audit_events drop constraint if exists wm_audit_events_actor_type_check;
alter table public.wm_audit_events add constraint wm_audit_events_actor_type_check
  check (actor_type in ('admin_session','customer_link','system','user','legacy_pin'));

update public.wm_tenants
set monthly_price = 0,
    subscription_due_at = null,
    grace_until = null,
    blocked_at = null
where slug = 'wm-vendas';

-- Dados comerciais permanecem acessíveis somente pelo backend com service_role.
revoke all on public.wm_tenants from anon, authenticated;
