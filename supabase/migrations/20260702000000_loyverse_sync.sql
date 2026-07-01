alter table public.menu_items
  add column if not exists loyverse_item_id text,
  add column if not exists loyverse_variant_id text,
  add column if not exists loyverse_sku text,
  add column if not exists loyverse_handle text,
  add column if not exists loyverse_updated_at timestamptz,
  add column if not exists loyverse_synced_at timestamptz,
  add column if not exists loyverse_raw jsonb;

create unique index if not exists menu_items_loyverse_variant_id_key
  on public.menu_items(loyverse_variant_id);

alter table public.sales_reports
  add column if not exists loyverse_receipt_number text,
  add column if not exists loyverse_store_id text,
  add column if not exists loyverse_receipt_date timestamptz,
  add column if not exists loyverse_source text,
  add column if not exists dining_option text,
  add column if not exists payment_summary text,
  add column if not exists loyverse_synced_at timestamptz,
  add column if not exists loyverse_raw jsonb;

create unique index if not exists sales_reports_loyverse_receipt_number_key
  on public.sales_reports(loyverse_receipt_number);

alter table public.sales_report_lines
  add column if not exists loyverse_line_id text,
  add column if not exists loyverse_receipt_number text,
  add column if not exists loyverse_item_id text,
  add column if not exists loyverse_variant_id text,
  add column if not exists loyverse_sku text;
