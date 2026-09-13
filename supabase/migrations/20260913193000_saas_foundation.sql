begin;

create table if not exists public.wm_tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  legal_name text,
  document text,
  owner_name text,
  owner_phone text,
  plan_code text not null default 'founder',
  subscription_status text not null default 'active' check (subscription_status in ('trialing','active','past_due','suspended','cancelled')),
  trial_ends_at timestamptz,
  limits jsonb not null default '{"products":500,"customers":500,"users":1,"monthly_orders":1000}'::jsonb,
  features jsonb not null default '{"storefront":true,"pix":true,"credit_sales":true,"payment_links":true,"reports":true}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.wm_tenants enable row level security;
revoke all on public.wm_tenants from anon, authenticated;
insert into public.wm_tenants(id,slug,name,legal_name,plan_code,subscription_status)
values('00000000-0000-4000-8000-000000000001','wm-vendas','WM Vendas','WM Vendas','founder','active')
on conflict (id) do nothing;

create table if not exists public.wm_tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.wm_tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  role text not null default 'owner' check (role in ('owner','admin','seller','viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(tenant_id,user_id)
);
alter table public.wm_tenant_members enable row level security;
revoke all on public.wm_tenant_members from anon, authenticated;

create table if not exists public.wm_subscriptions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.wm_tenants(id) on delete cascade,
  provider text, provider_customer_id text, provider_subscription_id text, plan_code text not null,
  status text not null check (status in ('trialing','active','past_due','suspended','cancelled')),
  current_period_start timestamptz, current_period_end timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists wm_subscriptions_tenant_status_idx on public.wm_subscriptions(tenant_id,status);
alter table public.wm_subscriptions enable row level security;
revoke all on public.wm_subscriptions from anon, authenticated;

do $$ declare t text; begin
  foreach t in array array['wm_app_config','wm_customers','wm_login_attempts','wm_products','wm_receivables','wm_sales','wm_sessions','wm_store_order_attempts','wm_store_order_items','wm_store_orders','wm_store_settings','wm_supplier_bills'] loop
    execute format('alter table public.%I add column if not exists tenant_id uuid',t);
    execute format('update public.%I set tenant_id=%L::uuid where tenant_id is null',t,'00000000-0000-4000-8000-000000000001');
    execute format('alter table public.%I alter column tenant_id set default %L::uuid',t,'00000000-0000-4000-8000-000000000001');
    execute format('alter table public.%I alter column tenant_id set not null',t);
    if not exists(select 1 from pg_constraint where conname=t||'_tenant_id_fkey') then execute format('alter table public.%I add constraint %I foreign key (tenant_id) references public.wm_tenants(id) on delete restrict',t,t||'_tenant_id_fkey'); end if;
    execute format('create index if not exists %I on public.%I(tenant_id)',t||'_tenant_idx',t);
  end loop;
end $$;

alter table public.wm_products drop constraint if exists wm_products_barcode_key;
create unique index if not exists wm_products_tenant_barcode_key on public.wm_products(tenant_id,barcode);
alter table public.wm_store_settings drop constraint if exists wm_store_settings_pkey;
alter table public.wm_store_settings add constraint wm_store_settings_pkey primary key (tenant_id);
alter table public.wm_app_config drop constraint if exists wm_app_config_pkey;
alter table public.wm_app_config add constraint wm_app_config_pkey primary key (tenant_id);

alter table public.wm_customers add column if not exists credit_allowed boolean not null default false;
alter table public.wm_customers add column if not exists credit_limit numeric(12,2) not null default 0 check (credit_limit >= 0);
alter table public.wm_customers add column if not exists credit_notes text not null default '';
alter table public.wm_store_orders add column if not exists customer_id bigint references public.wm_customers(id) on delete set null;
alter table public.wm_store_orders add column if not exists payment_method text not null default 'pix';
alter table public.wm_store_orders add column if not exists reservation_expires_at timestamptz not null default (now()+interval '24 hours');
alter table public.wm_store_orders add column if not exists delivery_status text not null default 'pending';
alter table public.wm_store_orders drop constraint if exists wm_store_orders_payment_method_check;
alter table public.wm_store_orders add constraint wm_store_orders_payment_method_check check (payment_method in ('pix','credit'));
alter table public.wm_store_orders drop constraint if exists wm_store_orders_delivery_status_check;
alter table public.wm_store_orders add constraint wm_store_orders_delivery_status_check check (delivery_status in ('pending','preparing','out_for_delivery','delivered','cancelled'));

create table if not exists public.wm_secure_links (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.wm_tenants(id) on delete cascade,
  token_hash text not null unique, purpose text not null check (purpose in ('customer_portal','receivable_payment','credit_purchase')),
  customer_id bigint not null references public.wm_customers(id) on delete cascade,
  receivable_id bigint references public.wm_receivables(id) on delete cascade,
  expires_at timestamptz not null, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists wm_secure_links_tenant_customer_idx on public.wm_secure_links(tenant_id,customer_id,expires_at desc);
alter table public.wm_secure_links enable row level security;
revoke all on public.wm_secure_links from anon, authenticated;

create table if not exists public.wm_payment_requests (
  id bigint generated by default as identity primary key, tenant_id uuid not null references public.wm_tenants(id) on delete restrict,
  customer_id bigint not null references public.wm_customers(id) on delete restrict,
  receivable_id bigint not null references public.wm_receivables(id) on delete restrict,
  amount numeric(12,2) not null check (amount>0), pix_payload text not null,
  status text not null default 'awaiting_confirmation' check (status in ('awaiting_confirmation','confirmed','cancelled')),
  confirmed_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists wm_payment_requests_tenant_status_idx on public.wm_payment_requests(tenant_id,status,created_at desc);
alter table public.wm_payment_requests enable row level security;
revoke all on public.wm_payment_requests from anon, authenticated;

create table if not exists public.wm_audit_events (
  id bigint generated by default as identity primary key, tenant_id uuid not null references public.wm_tenants(id) on delete restrict,
  actor_type text not null check (actor_type in ('admin_session','customer_link','system')), actor_id text,
  event_type text not null, entity_type text not null, entity_id text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists wm_audit_events_tenant_created_idx on public.wm_audit_events(tenant_id,created_at desc);
alter table public.wm_audit_events enable row level security;
revoke all on public.wm_audit_events from anon, authenticated;

create or replace function public.wm_verify_tenant_pin(p_slug text,p_pin text) returns uuid language sql security definer set search_path=''
as $$ select t.id from public.wm_tenants t join public.wm_app_config c on c.tenant_id=t.id where t.slug=p_slug and t.active and t.subscription_status in ('trialing','active') and c.pin_hash=extensions.crypt(p_pin,c.pin_hash) limit 1 $$;
revoke all on function public.wm_verify_tenant_pin(text,text) from public,anon,authenticated;
grant execute on function public.wm_verify_tenant_pin(text,text) to service_role;

commit;
