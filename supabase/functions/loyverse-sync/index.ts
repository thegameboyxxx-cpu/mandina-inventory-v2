import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LOYVERSE_URL = "https://api.loyverse.com/v1.0";
const FUNCTION_VERSION = "2026-07-02.6";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ function_version: FUNCTION_VERSION, ...body }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function textValue(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorBody(err: unknown) {
  const obj = err && typeof err === "object" ? err as Record<string, unknown> : null;
  const message = obj?.message && obj.message !== "[object Object]"
    ? textValue(obj.message)
    : textValue(err);
  return {
    error: message || "Unknown Edge Function error",
    detail: textValue(obj?.details || obj?.detail),
    hint: textValue(obj?.hint),
    code: textValue(obj?.code),
    raw_error: obj ? JSON.stringify(obj) : textValue(err),
  };
}

async function loyverseGet(token: string, path: string) {
  const res = await fetch(`${LOYVERSE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!res.ok) throw new Error(String(body.message || body.error || `Loyverse request failed (${res.status})`));
  return body;
}

async function loyverseGetAll(token: string, path: string, key: string) {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const pagePath = `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await loyverseGet(token, pagePath);
    rows.push(...((body[key] as Record<string, unknown>[] | undefined) || []));
    cursor = (body.cursor as string | undefined) || null;
    page += 1;
  } while (cursor && page < 30);
  return rows;
}

function dateStartIso(date: string) {
  return new Date(`${date}T00:00:00`).toISOString();
}

function dateEndIso(date: string) {
  const end = new Date(`${date}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return end.toISOString();
}

function optionName(variant: Record<string, unknown>) {
  return ["option1_value", "option2_value", "option3_value"]
    .map(key => variant[key])
    .filter(Boolean)
    .join(" / ");
}

function lineName(line: Record<string, unknown>) {
  return line.variant_name ? `${line.item_name} - ${line.variant_name}` : String(line.item_name || "");
}

function paymentSummary(receipt: Record<string, unknown>) {
  return ((receipt.payments as Record<string, unknown>[] | undefined) || [])
    .map(payment => `${payment.name || payment.type}: ${Number(payment.money_amount || 0).toFixed(2)}`)
    .join(", ");
}

function chunks<T>(rows: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += size) result.push(rows.slice(i, i + size));
  return result;
}

function secretNameForBranch(branchId: string) {
  return `LOYVERSE_TOKEN_${branchId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function tokenForBranch(branchId: string) {
  return Deno.env.get(secretNameForBranch(branchId)) || "";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function dateShift(base: string, days: number) {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!anonKey) return json({ error: "Missing Supabase anon key." }, 500);
    const serviceKey = Deno.env.get("MANDINA_SERVICE_ROLE_KEY")!;
    if (!serviceKey) return json({ error: "Missing MANDINA_SERVICE_ROLE_KEY secret." }, 500);
    const authClient = createClient(supabaseUrl, anonKey);
    const supabase = createClient(supabaseUrl, serviceKey);

    const auth = req.headers.get("Authorization") || "";
    const jwt = auth.replace("Bearer ", "");
    const { data: userData, error: userError } = await authClient.auth.getUser(jwt);
    if (userError || !userData.user) return json({ error: "Not authenticated.", detail: userError?.message || "" }, 401);

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    const body = await req.json();
    const role = String(profile?.role || "staff").toLowerCase();
    const isManager = role === "manager";

    if (body.action === "sync-menu-items") {
      if (!isManager) return json({ error: "Manager access required." }, 403);
      const token = String(body.token || "");
      if (!token) return json({ error: "Loyverse token is required." }, 400);
      const [items, categories] = await Promise.all([
        loyverseGetAll(token, "items?limit=250", "items"),
        loyverseGetAll(token, "categories?limit=250", "categories"),
      ]);
      const categoryById = new Map(categories.map(category => [category.id, category.name]));
      const now = new Date().toISOString();
      const rows = [];

      for (const item of items) {
        for (const variant of ((item.variants as Record<string, unknown>[] | undefined) || [])) {
          const stores = (variant.stores as Record<string, unknown>[] | undefined) || [];
          const storePrice = stores.find(store => store.available_for_sale !== false) || stores[0];
          const variantName = optionName(variant);
          rows.push({
            name: variantName ? `${item.item_name} - ${variantName}` : item.item_name,
            name_ar: null,
            category: categoryById.get(item.category_id) || null,
            sale_price: Number(storePrice?.price ?? variant.default_price ?? 0),
            active: !item.deleted_at && !variant.deleted_at && storePrice?.available_for_sale !== false,
            loyverse_item_id: item.id,
            loyverse_variant_id: variant.variant_id,
            loyverse_sku: variant.sku || null,
            loyverse_handle: item.handle || null,
            loyverse_updated_at: variant.updated_at || item.updated_at || null,
            loyverse_synced_at: now,
            loyverse_raw: { item, variant },
            updated_at: now,
            created_by: userData.user.id,
          });
        }
      }

      const cleanRows = rows.filter(row => row.loyverse_variant_id);
      const { error } = await supabase
        .from("menu_items")
        .upsert(cleanRows, { onConflict: "loyverse_variant_id" });
      if (error) throw error;
      return json({ loyverse_items: items.length, synced_menu_variants: cleanRows.length });
    }

    if (body.action === "import-sales") {
      const from = String(body.from || "");
      const to = String(body.to || "");
      const branchId = String(body.branch_id || "");
      if (!from || !to || !branchId) return json({ error: "from, to, and branch_id are required." }, 400);
      if (!isManager) {
        const allowed = new Set([todayIso(), dateShift(todayIso(), -1)]);
        if (from !== to || !allowed.has(from)) return json({ error: "Staff can only import today or yesterday." }, 403);
      }
      const token = String(body.token || "") || tokenForBranch(branchId);
      if (!token) return json({ error: `Loyverse token is required. Add Edge Function secret ${secretNameForBranch(branchId)} or provide a manager override token.` }, 400);

      const path = `receipts?limit=250&created_at_min=${encodeURIComponent(dateStartIso(from))}&created_at_max=${encodeURIComponent(dateEndIso(to))}`;
      const receipts = (await loyverseGetAll(token, path, "receipts"))
        .filter(receipt => receipt.receipt_type === "SALE" && !receipt.cancelled_at);

      const { data: menuItems, error: menuError } = await supabase
        .from("menu_items")
        .select("id, loyverse_variant_id");
      if (menuError) throw menuError;
      const menuByVariant = new Map((menuItems || []).map(item => [item.loyverse_variant_id, item.id]));

      const { data: existingReports, error: existingError } = await supabase
        .from("sales_reports")
        .select("id, status, loyverse_receipt_number")
        .eq("branch_id", branchId)
        .not("loyverse_receipt_number", "is", null);
      if (existingError) throw existingError;
      const existingByReceipt = new Map((existingReports || []).map(report => [report.loyverse_receipt_number, report]));

      let skippedExisting = 0;
      const receiptsToImport = [];
      for (const receipt of receipts) {
        const existing = existingByReceipt.get(receipt.receipt_number);
        if (existing) {
          skippedExisting += 1;
          continue;
        }
        receiptsToImport.push(receipt);
      }

      const now = new Date().toISOString();
      const reportPayloads = receiptsToImport.map(receipt => {
        const lineItems = (receipt.line_items as Record<string, unknown>[] | undefined) || [];
        return {
          branch_id: branchId,
          report_date: String(receipt.receipt_date || receipt.created_at || "").slice(0, 10),
          status: "draft",
          source: "loyverse",
          notes: receipt.note || null,
          total_items_sold: lineItems.reduce((sum, line) => sum + Number(line.quantity || 0), 0),
          total_sales_amount: Number(receipt.total_money || 0),
          payment_summary: paymentSummary(receipt),
          dining_option: receipt.dining_option || null,
          loyverse_receipt_number: receipt.receipt_number,
          loyverse_store_id: receipt.store_id || null,
          loyverse_receipt_date: receipt.receipt_date || null,
          loyverse_source: receipt.source || null,
          loyverse_synced_at: now,
          loyverse_raw: receipt,
          created_by: userData.user.id,
          updated_at: now,
        };
      });

      if (reportPayloads.length) {
        for (const batch of chunks(reportPayloads, 100)) {
          const { error } = await supabase
            .from("sales_reports")
            .upsert(batch, { onConflict: "loyverse_receipt_number" });
          if (error) throw error;
        }
      }

      const receiptNumbers = receiptsToImport.map(receipt => receipt.receipt_number).filter(Boolean);
      const importedReportIds = new Map<string, string>();
      for (const batch of chunks(receiptNumbers, 250)) {
        const { data: savedReports, error } = await supabase
          .from("sales_reports")
          .select("id, loyverse_receipt_number")
          .in("loyverse_receipt_number", batch);
        if (error) throw error;
        for (const report of savedReports || []) importedReportIds.set(report.loyverse_receipt_number, report.id);
      }

      const ids = [...importedReportIds.values()];
      for (const batch of chunks(ids, 250)) {
        const { error } = await supabase.from("sales_report_lines").delete().in("report_id", batch);
        if (error) throw error;
      }

      const allReportLines = [];
      for (const receipt of receiptsToImport) {
        const reportId = importedReportIds.get(String(receipt.receipt_number));
        if (!reportId) continue;
        const lineItems = (receipt.line_items as Record<string, unknown>[] | undefined) || [];
        const reportLines = lineItems.map(line => ({
          report_id: reportId,
          menu_item_id: menuByVariant.get(line.variant_id) || null,
          qty_sold: Number(line.quantity || 0),
          previous_qty: 0,
          unit_price: Number(line.price || 0),
          gross_sales_amount: Number(line.gross_total_money || 0),
          net_sales_amount: Number(line.total_money || 0),
          pos_item_name: lineName(line),
          status: "draft",
          notes: line.line_note || null,
          loyverse_line_id: line.id || null,
          loyverse_receipt_number: receipt.receipt_number,
          loyverse_item_id: line.item_id || null,
          loyverse_variant_id: line.variant_id || null,
          loyverse_sku: line.sku || null,
        }));
        allReportLines.push(...reportLines);
      }

      for (const batch of chunks(allReportLines, 500)) {
        const { error } = await supabase.from("sales_report_lines").insert(batch);
        if (error) throw error;
      }

      return json({
        receipts_read: receipts.length,
        imported: receiptsToImport.length,
        lines_imported: allReportLines.length,
        skipped_existing: skippedExisting,
      });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    return json(errorBody(err), 500);
  }
});
