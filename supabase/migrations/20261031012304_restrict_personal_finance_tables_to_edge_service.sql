revoke all on table public.wm_personal_records from anon, authenticated;
revoke all on table public.wm_personal_record_payments from anon, authenticated;
revoke all on sequence public.wm_personal_records_id_seq from anon, authenticated;
revoke all on sequence public.wm_personal_record_payments_id_seq from anon, authenticated;
comment on table public.wm_personal_records is 'Private tenant-scoped financial organizer records; accessed through the authenticated WM Vendas Edge Function.';
comment on table public.wm_personal_record_payments is 'Private tenant-scoped payment history for organizer records; accessed through the authenticated WM Vendas Edge Function.';