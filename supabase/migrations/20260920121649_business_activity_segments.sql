alter table public.wm_tenants
  add column if not exists business_activity text not null default 'commerce',
  add column if not exists business_segment text not null default 'general_retail',
  add column if not exists business_config jsonb not null default '{}'::jsonb;

alter table public.wm_tenants
  drop constraint if exists wm_tenants_business_activity_check;

alter table public.wm_tenants
  add constraint wm_tenants_business_activity_check
  check (business_activity in ('commerce', 'food', 'services'));

create index if not exists wm_tenants_business_profile_idx
  on public.wm_tenants (business_activity, business_segment)
  where active = true;

update public.wm_tenants
set business_activity = 'commerce',
    business_segment = 'beauty_jewelry',
    updated_at = now()
where slug = 'wm-vendas';
