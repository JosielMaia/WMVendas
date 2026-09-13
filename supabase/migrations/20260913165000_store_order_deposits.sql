alter table public.wm_store_orders
  add column if not exists deposit_percent smallint,
  add column if not exists deposit_amount numeric(12,2),
  add column if not exists balance_due numeric(12,2);

alter table public.wm_store_orders drop constraint if exists wm_store_orders_payment_method_check;
alter table public.wm_store_orders add constraint wm_store_orders_payment_method_check
  check (payment_method = any (array['pix'::text,'credit'::text,'reservation'::text,'deposit'::text]));

alter table public.wm_store_orders add constraint wm_store_orders_deposit_percent_check
  check (deposit_percent is null or deposit_percent in (20,30));
alter table public.wm_store_orders add constraint wm_store_orders_deposit_amount_check
  check (deposit_amount is null or deposit_amount >= 0);
alter table public.wm_store_orders add constraint wm_store_orders_balance_due_check
  check (balance_due is null or balance_due >= 0);
