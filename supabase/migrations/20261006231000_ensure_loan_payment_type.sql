begin;
alter table public.wm_loan_payments add column if not exists payment_type text not null default 'normal'
  check (payment_type in ('normal','interest_only','principal_only'));
create index if not exists wm_loan_payments_type_idx on public.wm_loan_payments(tenant_id,payment_type);
commit;