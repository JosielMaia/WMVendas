alter table public.wm_store_orders drop constraint if exists wm_store_orders_payment_method_check;
alter table public.wm_store_orders add constraint wm_store_orders_payment_method_check
  check (payment_method in ('pix','credit','reservation'));

alter table public.wm_store_orders drop constraint if exists wm_store_orders_status_check;
alter table public.wm_store_orders add constraint wm_store_orders_status_check
  check (status in ('awaiting_payment','awaiting_approval','reserved','paid','preparing','completed','cancelled'));

create or replace function public.wm_create_store_order_v2(
  p_tenant_id uuid, p_customer_name text, p_phone text, p_delivery_type text,
  p_address text, p_payment_method text, p_items jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_order_id bigint; v_public_id uuid; v_status text; v_item jsonb;
  v_product public.wm_products%rowtype; v_quantity integer; v_total numeric(12,2):=0;
begin
  if p_tenant_id is null then raise exception 'Loja inválida.'; end if;
  if length(trim(coalesce(p_customer_name,'')))<2 then raise exception 'Informe seu nome.'; end if;
  if length(regexp_replace(coalesce(p_phone,''),'\D','','g'))<10 then raise exception 'Informe um WhatsApp válido.'; end if;
  if p_delivery_type not in ('retirada','entrega') then raise exception 'Forma de entrega inválida.'; end if;
  if p_delivery_type='entrega' and length(trim(coalesce(p_address,'')))<5 then raise exception 'Informe o endereço de entrega.'; end if;
  if p_payment_method not in ('pix','reservation') then raise exception 'Forma de pagamento inválida.'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 or jsonb_array_length(p_items)>30 then raise exception 'Cesta inválida.'; end if;
  v_status:=case when p_payment_method='reservation' then 'awaiting_approval' else 'awaiting_payment' end;
  insert into public.wm_store_orders(tenant_id,customer_name,phone,delivery_type,address,payment_method,status,reservation_expires_at)
  values(p_tenant_id,trim(p_customer_name),regexp_replace(p_phone,'\D','','g'),p_delivery_type,trim(coalesce(p_address,'')),p_payment_method,v_status,now()+interval '24 hours')
  returning id,public_id into v_order_id,v_public_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_quantity:=greatest(0,least(99,coalesce((v_item->>'quantity')::integer,0)));
    if v_quantity<1 then raise exception 'Quantidade inválida.'; end if;
    select * into v_product from public.wm_products where id=(v_item->>'productId')::bigint and tenant_id=p_tenant_id for update;
    if not found then raise exception 'Produto não encontrado.'; end if;
    if v_product.stock<v_quantity then raise exception 'Estoque insuficiente para %.',v_product.name; end if;
    insert into public.wm_store_order_items(tenant_id,order_id,product_id,product_name,unit_price,quantity,line_total)
    values(p_tenant_id,v_order_id,v_product.id,v_product.name,v_product.sale_price,v_quantity,v_product.sale_price*v_quantity);
    update public.wm_products set stock=stock-v_quantity,updated_at=now() where id=v_product.id and tenant_id=p_tenant_id;
    v_total:=v_total+(v_product.sale_price*v_quantity);
  end loop;
  update public.wm_store_orders set subtotal=v_total,total=v_total,updated_at=now() where id=v_order_id and tenant_id=p_tenant_id;
  return jsonb_build_object('id',v_order_id,'publicId',v_public_id,'total',v_total,'status',v_status,'paymentMethod',p_payment_method);
end;
$$;
revoke all on function public.wm_create_store_order_v2(uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.wm_create_store_order_v2(uuid,text,text,text,text,text,jsonb) to service_role;

create or replace function public.wm_cancel_store_order(p_order_id bigint)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_status text; v_item record;
begin
  select status into v_status from public.wm_store_orders where id=p_order_id for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if v_status not in ('awaiting_payment','awaiting_approval','reserved') then raise exception 'Este pedido não pode mais ser cancelado.'; end if;
  for v_item in select product_id,quantity from public.wm_store_order_items where order_id=p_order_id loop
    update public.wm_products set stock=stock+v_item.quantity,updated_at=now() where id=v_item.product_id;
  end loop;
  update public.wm_store_orders set status='cancelled',delivery_status='cancelled',updated_at=now() where id=p_order_id;
end;
$$;
revoke all on function public.wm_cancel_store_order(bigint) from public,anon,authenticated;
grant execute on function public.wm_cancel_store_order(bigint) to service_role;
