create or replace function public.wm_create_personal_record(
  p_tenant_id uuid,
  p_finance_scope text,
  p_entry_type text,
  p_person_name text,
  p_person_phone text,
  p_description text,
  p_category text,
  p_amount numeric,
  p_occurred_at date,
  p_due_date date,
  p_reminder_at timestamptz,
  p_notes text,
  p_payment_method text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id bigint;
  v_now timestamptz := now();
  v_immediate boolean;
  v_cash_kind text;
  v_payment_method text := left(coalesce(p_payment_method,'outro'),30);
begin
  if p_finance_scope not in ('store','personal') then raise exception 'Área financeira inválida.'; end if;
  if p_entry_type not in ('sale_other_person','loan_given','loan_received','income','expense','payable','receivable') then
    raise exception 'Tipo de registro inválido.';
  end if;
  if p_description is null or length(trim(p_description)) < 2 or p_amount is null or p_amount <= 0 then
    raise exception 'Descrição e valor são obrigatórios.';
  end if;

  v_immediate := p_entry_type in ('income','expense');

  insert into public.wm_personal_records (
    tenant_id,finance_scope,entry_type,person_name,person_phone,description,category,
    amount,paid_amount,status,payment_method,paid_at,occurred_at,due_date,reminder_at,notes
  ) values (
    p_tenant_id,p_finance_scope,p_entry_type,nullif(trim(p_person_name),''),nullif(trim(p_person_phone),''),
    trim(p_description),coalesce(nullif(trim(p_category),''),'Outros'),round(p_amount,2),
    case when v_immediate then round(p_amount,2) else 0 end,
    case when v_immediate then 'paid' else 'open' end,
    case when p_entry_type in ('income','expense','sale_other_person','loan_given','loan_received') then v_payment_method else null end,
    case when v_immediate then v_now else null end,
    coalesce(p_occurred_at,current_date),p_due_date,p_reminder_at,nullif(left(coalesce(p_notes,''),1000),'')
  ) returning id into v_id;

  if v_immediate then
    insert into public.wm_personal_record_payments
      (tenant_id,record_id,amount,payment_method,paid_at,notes)
    values (p_tenant_id,v_id,round(p_amount,2),v_payment_method,v_now,'Movimentação concluída no registro inicial.');
  end if;

  if p_finance_scope = 'store' then
    v_cash_kind := case
      when p_entry_type in ('sale_other_person','loan_given','expense','payable') then
        case when p_entry_type='payable' then null else 'expense' end
      when p_entry_type in ('loan_received','income','receivable') then
        case when p_entry_type='receivable' then null else 'income' end
      else null
    end;
    if v_cash_kind is not null then
      insert into public.wm_cash_entries
        (tenant_id,kind,category,description,amount,payment_method,occurred_at,source_type,source_id)
      values (
        p_tenant_id,v_cash_kind,coalesce(nullif(trim(p_category),''),'Outros'),
        trim(p_description),round(p_amount,2),v_payment_method,
        coalesce(p_occurred_at,current_date)::timestamp at time zone 'America/Belem',
        'personal_record',v_id
      );
    end if;
  end if;

  return jsonb_build_object('id',v_id,'immediate',v_immediate);
end;
$$;

create or replace function public.wm_record_personal_record_payment(
  p_tenant_id uuid,
  p_record_id bigint,
  p_amount numeric,
  p_payment_method text default 'outro',
  p_paid_at timestamptz default now(),
  p_notes text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_record public.wm_personal_records%rowtype;
  v_paid numeric(12,2);
  v_status text;
  v_payment_id bigint;
  v_cash_kind text;
begin
  select * into v_record
  from public.wm_personal_records
  where tenant_id = p_tenant_id and id = p_record_id
  for update;

  if not found then raise exception 'Registro não encontrado.'; end if;
  if v_record.status in ('paid','canceled') then raise exception 'Este registro já está encerrado.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > (v_record.amount - v_record.paid_amount) then
    raise exception 'Valor de pagamento inválido ou maior que o saldo em aberto.';
  end if;

  v_paid := round(v_record.paid_amount + p_amount, 2);
  v_status := case when v_paid >= v_record.amount then 'paid' else 'partial' end;

  insert into public.wm_personal_record_payments
    (tenant_id,record_id,amount,payment_method,paid_at,notes)
  values
    (p_tenant_id,p_record_id,round(p_amount,2),left(coalesce(p_payment_method,'outro'),30),
     coalesce(p_paid_at,now()),nullif(left(coalesce(p_notes,''),500),''))
  returning id into v_payment_id;

  update public.wm_personal_records
  set paid_amount=v_paid,status=v_status,payment_method=left(coalesce(p_payment_method,'outro'),30),
      paid_at=case when v_status='paid' then coalesce(p_paid_at,now()) else null end,updated_at=now()
  where tenant_id=p_tenant_id and id=p_record_id;

  if v_record.finance_scope='store' then
    v_cash_kind := case
      when v_record.entry_type in ('sale_other_person','loan_given','receivable') then 'income'
      when v_record.entry_type in ('loan_received','payable') then 'expense'
      else null
    end;
    if v_cash_kind is not null then
      insert into public.wm_cash_entries
        (tenant_id,kind,category,description,amount,payment_method,occurred_at,source_type,source_id)
      values
        (p_tenant_id,v_cash_kind,v_record.category,
         case when v_cash_kind='income' then 'Recebimento — ' else 'Pagamento — ' end || v_record.description,
         round(p_amount,2),left(coalesce(p_payment_method,'outro'),30),coalesce(p_paid_at,now()),
         'personal_record_payment',v_payment_id);
    end if;
  end if;

  return jsonb_build_object('paymentId',v_payment_id,'paidAmount',v_paid,'status',v_status,
    'remainingAmount',round(v_record.amount-v_paid,2));
end;
$$;

revoke all on function public.wm_create_personal_record(uuid,text,text,text,text,text,text,numeric,date,date,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.wm_create_personal_record(uuid,text,text,text,text,text,text,numeric,date,date,timestamptz,text,text) to service_role;
revoke all on function public.wm_record_personal_record_payment(uuid,bigint,numeric,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.wm_record_personal_record_payment(uuid,bigint,numeric,text,timestamptz,text) to service_role;