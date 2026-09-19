alter table public.wm_store_settings add column if not exists logo_path text;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('wm-store-assets','wm-store-assets',false,1048576,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;
