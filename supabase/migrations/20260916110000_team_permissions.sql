-- Equipe, permissões e trilha de auditoria
alter table public.wm_tenant_members add column if not exists name text;
alter table public.wm_tenant_members add column if not exists created_by uuid references public.wm_tenant_members(id) on delete set null;
alter table public.wm_tenant_members add column if not exists updated_at timestamptz not null default now();

create unique index if not exists wm_tenant_members_tenant_email_uidx
  on public.wm_tenant_members(tenant_id, lower(email)) where email is not null;
create index if not exists wm_tenant_members_tenant_active_idx
  on public.wm_tenant_members(tenant_id, active);
create index if not exists wm_audit_events_tenant_created_idx
  on public.wm_audit_events(tenant_id, created_at desc);

update public.wm_tenants
set limits = jsonb_set(limits, '{users}', '5'::jsonb, true), updated_at = now()
where coalesce((limits->>'users')::int, 1) < 5;

update public.wm_tenant_members m
set name = coalesce(nullif(t.owner_name, ''), split_part(m.email, '@', 1), 'Proprietário'),
    updated_at = now()
from public.wm_tenants t
where m.tenant_id = t.id and m.name is null;
