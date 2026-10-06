begin;

-- Recalcula a parcela separando principal, juros contratados e encargos.
create or replace function public.wm_calculate_loan_installment_due(
  p_tenant_id uuid,
  p_installment_id bigint,
  p_as_of_date date default current_date
)
returns jsonb
language plpgsql
set search_path to 'public','pg_temp'
as $$
declare
  v_i public.wm_loan_installments%rowtype;
  v_l public.wm_loans%rowtype;
  v_normal_paid numeric(12,2);
  v_interest_paid numeric(12,2);
  v_interest_alloc numeric(12,2);
  v_principal_amount numeric(12,2);
  v_principal_remaining numeric(12,2);
  v_interest_remaining numeric(12,2);
  v_base_interest numeric(12,2);
  v_days integer;
  v_penalty numeric(12,2):=0;
  v_late_interest numeric(12,2):=0;
  v_cap numeric(12,2);
  v_total numeric(12,2);
  v_rate numeric;
begin
  select * into v_i from public.wm_loan_installments
    where tenant_id=p_tenant_id and id=p_installment_id;
  if not found then raise exception 'Parcela do empréstimo não encontrada.'; end if;

  select * into v_l from public.wm_loans
    where tenant_id=p_tenant_id and id=v_i.loan_id;
  if not found then raise exception 'Empréstimo não encontrado.'; end if;

  -- Distribui o juro contratual pelas parcelas, corrigindo o arredondamento na última.
  v_base_interest:=round(v_l.interest_amount/greatest(v_l.installments,1),2);
  if v_i.installment_number < v_l.installments then
    v_interest_alloc:=v_base_interest;
  else
    v_interest_alloc:=round(v_l.interest_amount-(v_base_interest*(greatest(v_l.installments,1)-1)),2);
  end if;
  v_interest_alloc:=greatest(v_interest_alloc,0);
  v_principal_amount:=greatest(round(v_i.amount-v_interest_alloc,2),0);

  -- Pagamentos somente de juros não reduzem principal nem o valor da dívida principal.
  select coalesce(sum(amount),0) into v_normal_paid
    from public.wm_loan_payments
    where tenant_id=p_tenant_id and installment_id=v_i.id
      and coalesce(payment_type,'normal')<>'interest_only';

  select coalesce(sum(amount),0) into v_interest_paid
    from public.wm_loan_payments
    where tenant_id=p_tenant_id and installment_id=v_i.id
      and payment_type='interest_only';

  v_principal_remaining:=greatest(round(v_principal_amount-v_normal_paid,2),0);
  v_interest_remaining:=greatest(round(v_interest_alloc-v_interest_paid,2),0);

  v_days:=greatest((coalesce(p_as_of_date,current_date)-v_i.due_date)-v_l.grace_days,0);

  if v_days>0 and (v_principal_remaining+v_interest_remaining)>0 then
    v_penalty:=round((v_principal_remaining+v_interest_remaining)*v_l.late_penalty_rate/100,2);
    v_rate:=v_l.late_interest_daily_rate/100;
    if v_rate>0 then
      if v_l.late_interest_compound then
        v_late_interest:=round((v_principal_remaining+v_interest_remaining)*(power(1+v_rate,v_days)-1),2);
      else
        v_late_interest:=round((v_principal_remaining+v_interest_remaining)*v_rate*v_days,2);
      end if;
    end if;
    v_cap:=round(v_i.amount*v_l.late_charge_cap_rate/100,2);
    if v_cap>=0 and v_penalty+v_late_interest>v_cap then
      if v_penalty>=v_cap then
        v_penalty:=v_cap;
        v_late_interest:=0;
      else
        v_late_interest:=greatest(round(v_cap-v_penalty,2),0);
      end if;
    end if;
  end if;

  v_total:=round(v_principal_remaining+v_interest_remaining+v_penalty+v_late_interest,2);

  return jsonb_build_object(
    'installmentId',v_i.id,
    'loanId',v_l.id,
    'dueDate',v_i.due_date,
    'amount',v_i.amount,
    'contractualInterest',v_interest_alloc,
    'interestPaid',v_interest_paid,
    'principalAmount',v_principal_amount,
    'principalPaid',greatest(round(least(v_normal_paid,v_principal_amount),2),0),
    'paidAmount',round(v_normal_paid,2),
    'remainingPrincipal',v_principal_remaining,
    'remainingInterest',v_interest_remaining,
    'daysLate',v_days,
    'latePenalty',v_penalty,
    'lateInterest',v_late_interest,
    'lateCharges',round(v_penalty+v_late_interest,2),
    'totalDue',v_total,
    'status',case when v_i.status='paid' or v_total<=0 then 'paid' else 'pending' end
  );
end; $$;

-- Pagamento normal: considera somente pagamentos que reduzem a parcela/principal.
create or replace function public.wm_record_loan_payment(
  p_tenant_id uuid,
  p_installment_id bigint,
  p_amount numeric,
  p_payment_method text default 'dinheiro',
  p_paid_at timestamptz default now(),
  p_notes text default ''
)
returns jsonb
language plpgsql
set search_path to 'public','pg_temp'
as $$
declare
  v_installment public.wm_loan_installments%rowtype;
  v_loan public.wm_loans%rowtype;
  v_customer public.wm_customers%rowtype;
  v_due jsonb;
  v_paid numeric(12,2);
  v_total_due numeric(12,2);
  v_payment_id bigint;
  v_cash_id bigint;
  v_status text;
  v_msg text;
begin
  if p_amount is null or p_amount<=0 then raise exception 'Informe um valor de pagamento válido.'; end if;

  select * into v_installment from public.wm_loan_installments
    where tenant_id=p_tenant_id and id=p_installment_id for update;
  if not found then raise exception 'Parcela do empréstimo não encontrada.'; end if;

  select * into v_loan from public.wm_loans
    where tenant_id=p_tenant_id and id=v_installment.loan_id for update;
  if not found then raise exception 'Empréstimo não encontrado.'; end if;
  if v_loan.status='cancelled' then raise exception 'Este empréstimo está cancelado.'; end if;

  select * into v_customer from public.wm_customers
    where tenant_id=p_tenant_id and id=v_loan.customer_id;
  if not found then raise exception 'Cliente não encontrado.'; end if;

  select public.wm_calculate_loan_installment_due(
    p_tenant_id,v_installment.id,coalesce(p_paid_at::date,current_date)
  ) into v_due;

  v_paid:=coalesce((v_due->>'paidAmount')::numeric,0);
  v_total_due:=coalesce((v_due->>'totalDue')::numeric,0);

  if v_total_due<=0 then raise exception 'Esta parcela já está quitada.'; end if;
  if round(p_amount,2)>v_total_due+0.005 then
    v_msg:='O pagamento não pode ser maior que o total devido de '||to_char(v_total_due,'FM999999990.00')||'.';
    raise exception using message=v_msg;
  end if;

  insert into public.wm_loan_payments(
    tenant_id,loan_id,installment_id,customer_id,amount,payment_method,paid_at,notes,payment_type
  )
  values(
    p_tenant_id,v_loan.id,v_installment.id,v_loan.customer_id,round(p_amount,2),
    coalesce(nullif(trim(p_payment_method),''),'dinheiro'),
    coalesce(p_paid_at,now()),
    coalesce(p_notes,'')||case when coalesce((v_due->>'lateCharges')::numeric,0)>0 then ' | Encargos por atraso: '||to_char((v_due->>'lateCharges')::numeric,'FM999999990.00') else '' end,
    'normal'
  )
  returning id into v_payment_id;

  v_paid:=round(v_paid+round(p_amount,2),2);

  if v_paid>=v_total_due-0.005 then
    update public.wm_loan_installments
      set status='paid',paid_at=coalesce(p_paid_at,now())
      where id=v_installment.id and tenant_id=p_tenant_id;
  end if;

  if not exists(
    select 1 from public.wm_loan_installments li
    where li.tenant_id=p_tenant_id and li.loan_id=v_loan.id and li.status='pending'
  ) then
    update public.wm_loans set status='paid',updated_at=now()
      where tenant_id=p_tenant_id and id=v_loan.id;
    v_status:='paid';
  else
    v_status:='active';
  end if;

  insert into public.wm_cash_entries(
    tenant_id,kind,category,description,amount,payment_method,occurred_at,source_type,source_id
  )
  values(
    p_tenant_id,'income','Recebimento de empréstimo',
    'Parcela '||v_installment.installment_number||' — '||v_customer.name,
    round(p_amount,2),coalesce(nullif(trim(p_payment_method),''),'dinheiro'),
    coalesce(p_paid_at,now()),'loan_payment',v_payment_id
  )
  returning id into v_cash_id;

  return jsonb_build_object(
    'loanPaymentId',v_payment_id,'cashEntryId',v_cash_id,'loanId',v_loan.id,
    'installmentId',v_installment.id,'customerId',v_customer.id,'customerName',v_customer.name,
    'installmentNumber',v_installment.installment_number,'paymentType','normal',
    'installmentAmount',v_installment.amount,'paidAmount',round(p_amount,2),
    'paidTotal',v_paid,'remainingAmount',greatest(v_total_due-v_paid,0),
    'dueDate',v_installment.due_date,'paidAt',coalesce(p_paid_at,now()),
    'paymentMethod',coalesce(nullif(trim(p_payment_method),''),'dinheiro'),
    'daysLate',coalesce((v_due->>'daysLate')::integer,0),
    'latePenalty',coalesce((v_due->>'latePenalty')::numeric,0),
    'lateInterest',coalesce((v_due->>'lateInterest')::numeric,0),
    'lateCharges',coalesce((v_due->>'lateCharges')::numeric,0),
    'totalDue',v_total_due,'status',v_status
  );
end; $$;

-- Somente juros: recebe juros contratuais e, se houver, encargos, sem reduzir o principal.
create or replace function public.wm_record_loan_interest_payment(
  p_tenant_id uuid,
  p_installment_id bigint,
  p_amount numeric,
  p_payment_method text default 'dinheiro',
  p_paid_at timestamptz default now(),
  p_notes text default ''
)
returns jsonb
language plpgsql
set search_path to 'public','pg_temp'
as $$
declare
  v_i public.wm_loan_installments%rowtype;
  v_l public.wm_loans%rowtype;
  v_customer public.wm_customers%rowtype;
  v_due jsonb;
  v_interest_due numeric(12,2);
  v_payment_id bigint;
  v_cash_id bigint;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Informe um valor de juros válido.'; end if;

  select * into v_i from public.wm_loan_installments
    where tenant_id=p_tenant_id and id=p_installment_id for update;
  if not found then raise exception 'Parcela do empréstimo não encontrada.'; end if;

  select * into v_l from public.wm_loans
    where tenant_id=p_tenant_id and id=v_i.loan_id for update;
  if not found then raise exception 'Empréstimo não encontrado.'; end if;
  if v_l.status='cancelled' then raise exception 'Este empréstimo está cancelado.'; end if;

  select * into v_customer from public.wm_customers
    where tenant_id=p_tenant_id and id=v_l.customer_id;
  if not found then raise exception 'Cliente não encontrado.'; end if;

  select public.wm_calculate_loan_installment_due(
    p_tenant_id,v_i.id,coalesce(p_paid_at::date,current_date)
  ) into v_due;

  v_interest_due:=greatest(
    0,
    coalesce((v_due->>'remainingInterest')::numeric,0)
    + coalesce((v_due->>'lateCharges')::numeric,0)
  );

  if v_interest_due<=0 then
    raise exception 'Não há juros ou encargos pendentes para esta parcela.';
  end if;

  if round(p_amount,2)>round(v_interest_due,2)+0.005 then
    raise exception 'O pagamento de juros não pode ser maior que os juros/encargos pendentes de '||
      to_char(v_interest_due,'FM999999990.00')||'.';
  end if;

  insert into public.wm_loan_payments(
    tenant_id,loan_id,installment_id,customer_id,amount,payment_method,paid_at,notes,payment_type
  )
  values(
    p_tenant_id,v_l.id,v_i.id,v_l.customer_id,round(p_amount,2),
    coalesce(nullif(trim(p_payment_method),''),'dinheiro'),
    coalesce(p_paid_at,now()),
    coalesce(p_notes,'')||' | Pagamento somente de juros/encargos; principal permanece em aberto.',
    'interest_only'
  )
  returning id into v_payment_id;

  insert into public.wm_cash_entries(
    tenant_id,kind,category,description,amount,payment_method,occurred_at,source_type,source_id
  )
  values(
    p_tenant_id,'income','Juros de empréstimo',
    'Juros/encargos — parcela '||v_i.installment_number||' — '||v_customer.name,
    round(p_amount,2),coalesce(nullif(trim(p_payment_method),''),'dinheiro'),
    coalesce(p_paid_at,now()),'loan_interest_payment',v_payment_id
  )
  returning id into v_cash_id;

  return jsonb_build_object(
    'loanPaymentId',v_payment_id,'cashEntryId',v_cash_id,'loanId',v_l.id,
    'installmentId',v_i.id,'customerId',v_customer.id,'customerName',v_customer.name,
    'installmentNumber',v_i.installment_number,'paymentType','interest_only',
    'interestPaid',round(p_amount,2),'principalRemaining',round(v_due->>'principalRemaining',2),
    'remainingInterest',greatest(round(v_interest_due-p_amount,2),0),
    'totalDueAfterPayment',greatest(round((v_due->>'totalDue')::numeric-p_amount,2),0),
    'message','Juros pagos. O principal permanece em aberto.'
  );
end; $$;

revoke all on function public.wm_calculate_loan_installment_due(uuid,bigint,date),
  public.wm_record_loan_payment(uuid,bigint,numeric,text,timestamptz,text),
  public.wm_record_loan_interest_payment(uuid,bigint,numeric,text,timestamptz,text)
  from public,anon,authenticated;

grant execute on function public.wm_calculate_loan_installment_due(uuid,bigint,date),
  public.wm_record_loan_payment(uuid,bigint,numeric,text,timestamptz,text),
  public.wm_record_loan_interest_payment(uuid,bigint,numeric,text,timestamptz,text)
  to service_role;

commit;