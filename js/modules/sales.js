import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal, today } from "../utils.js";
import { safeSelect, insertRow, updateRow, deleteRows } from "../services/db.js";
import { loyverseSync } from "../services/loyverse.js";
import { loadItems } from "./items.js";

let reports = [];
let lines = [];
let menuItems = [];
let components = [];
let filters = { from: "", to: "", source: "", item: "", payment: "" };

const menuName = m => m ? `${m.name}${m.name_ar ? " / " + m.name_ar : ""}` : "Menu Item";
const item = id => (state.items || []).find(i => i.id === id);
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";
const reportNo = r => r?.loyverse_receipt_number || `SR-${String(r?.id || "").slice(0, 8)}`;
const errText = err => {
  const value = err?.message ?? err;
  if (!value) return "Unknown error";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

async function loadSalesData() {
  await loadItems();
  reports = await selectAll("sales_reports", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  const reportIds = new Set(reports.map(r => r.id));
  lines = (await selectAll("sales_report_lines", "*").catch(() => [])).filter(line => reportIds.has(line.report_id));
  menuItems = await safeSelect("menu_items", "*", { order: "name" }).catch(() => []);
  components = await safeSelect("menu_item_components", "*", { order: "sort_order" }).catch(() => []);
}

async function selectAll(table, columns = "*", options = {}) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  while (true) {
    let q = state.db.from(table).select(columns).range(from, from + pageSize - 1);
    if (options.eq) for (const [key, value] of Object.entries(options.eq)) q = q.eq(key, value);
    if (options.order) q = q.order(options.order, { ascending: options.ascending ?? true });
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

export async function renderSales() {
  if (!isManager()) return $("content").innerHTML = showError("Staff users cannot access Sales.");
  const content = $("content");
  content.innerHTML = '<div class="card">Loading sales...</div>';
  try {
    await loadSalesData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Sales</h2>
          <div class="toolbar">
            <input id="salesFrom" class="input" type="date">
            <input id="salesTo" class="input" type="date">
            <input id="salesItemFilter" class="input" placeholder="Search item...">
            <select id="salesPaymentFilter"><option value="">All payment</option></select>
            <select id="salesSourceFilter"><option value="">All source</option><option value="manual">Manual</option><option value="loyverse">Loyverse</option></select>
            <button class="btn secondary" id="importLoyverseSalesBtn">Import Loyverse Sales</button>
            <button class="btn" id="newSalesBtn">+ Manual Sales Entry</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Sales reports use Menu Item deduction mappings to create SALES_DEDUCTION stock movements when processed.</div>
        <div id="salesTable"></div>
      </div>
    `;
    $("salesFrom").value = filters.from;
    $("salesTo").value = filters.to;
    $("salesItemFilter").value = filters.item;
    $("salesPaymentFilter").innerHTML = paymentOptions();
    $("salesPaymentFilter").value = filters.payment;
    $("salesSourceFilter").value = filters.source;
    $("salesFrom").onchange = e => { filters.from = e.target.value; renderSalesTable(); };
    $("salesTo").onchange = e => { filters.to = e.target.value; renderSalesTable(); };
    $("salesItemFilter").oninput = e => { filters.item = e.target.value; renderSalesTable(); };
    $("salesPaymentFilter").onchange = e => { filters.payment = e.target.value; renderSalesTable(); };
    $("salesSourceFilter").onchange = e => { filters.source = e.target.value; renderSalesTable(); };
    $("importLoyverseSalesBtn").onclick = openLoyverseSalesImportModal;
    $("newSalesBtn").onclick = openSalesModal;
    renderSalesTable();
  } catch (e) {
    content.innerHTML = showError("Could not load Sales. " + errText(e));
  }
}

function linesFor(reportId) {
  return lines.filter(l => l.report_id === reportId);
}

function paymentOptions() {
  const names = [...new Set(reports.flatMap(r => paymentNames(r.payment_summary)))].filter(Boolean).sort();
  return '<option value="">All payment</option>' + names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
}

function paymentNames(summary) {
  return String(summary || "")
    .split(",")
    .map(part => part.split(":")[0]?.trim())
    .filter(Boolean);
}

function renderSalesTable() {
  const itemQuery = filters.item.trim().toLowerCase();
  const filteredReports = reports.filter(r => {
    const d = (r.report_date || "").slice(0, 10);
    if (filters.from && d < filters.from) return false;
    if (filters.to && d > filters.to) return false;
    if (filters.source && (r.source || "manual") !== filters.source) return false;
    if (filters.payment && !paymentNames(r.payment_summary).includes(filters.payment)) return false;
    if (itemQuery) {
      const haystack = linesFor(r.id).map(line => `${line.pos_item_name || ""} ${menuName(menuItems.find(m => m.id === line.menu_item_id))}`).join(" ").toLowerCase();
      if (!haystack.includes(itemQuery)) return false;
    }
    return true;
  });
  const allLines = filteredReports.flatMap(r => linesFor(r.id));
  const totalSales = filteredReports.reduce((s, r) => s + Number(r.total_sales_amount || linesFor(r.id).reduce((x, l) => x + Number(l.net_sales_amount || 0), 0)), 0);
  const totalItems = filteredReports.reduce((s, r) => s + Number(r.total_items_sold || linesFor(r.id).reduce((x, l) => x + Number(l.qty_sold || 0), 0)), 0);
  const byItem = new Map();
  for (const line of allLines) {
    const key = line.pos_item_name || menuName(menuItems.find(m => m.id === line.menu_item_id));
    const prev = byItem.get(key) || { qty: 0, sales: 0 };
    prev.qty += Number(line.qty_sold || 0);
    prev.sales += Number(line.net_sales_amount || 0);
    byItem.set(key, prev);
  }
  const topItems = [...byItem.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);

  $("salesTable").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Reports</div><div><b>${filteredReports.length}</b></div></div>
      <div class="card"><div class="stat-title">Items Sold</div><div><b>${qty(totalItems)}</b></div></div>
      <div class="card"><div class="stat-title">Sales Amount</div><div><b>${money(totalSales)}</b></div></div>
      <div class="card"><div class="stat-title">Top Item</div><div><b>${esc(topItems[0]?.[0] || "-")}</b></div></div>
    </div>
    ${topItems.length ? `<div class="card" style="margin-bottom:14px"><div class="stat-title">Top Sold Items</div>${topItems.map(([name, data]) => `<div>${esc(name)}: <b>${qty(data.qty)}</b> / ${money(data.sales)}</div>`).join("")}</div>` : ""}
    <table>
      <thead><tr><th>Report</th><th>Date</th><th>Source</th><th>Lines</th><th>Items Sold</th><th>Sales Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${filteredReports.map(r => {
          const reportLines = linesFor(r.id);
          return `<tr>
            <td><b>${esc(reportNo(r))}</b><div class="muted">${esc(r.payment_summary || r.notes || "")}</div></td>
            <td>${esc((r.report_date || "").slice(0, 10))}</td>
            <td><span class="badge ${r.source === "loyverse" ? "blue" : "gold"}">${esc(r.source || "manual")}</span></td>
            <td>${reportLines.length}</td>
            <td>${qty(r.total_items_sold || reportLines.reduce((s, l) => s + Number(l.qty_sold || 0), 0))}</td>
            <td>${money(r.total_sales_amount || reportLines.reduce((s, l) => s + Number(l.net_sales_amount || 0), 0))}</td>
            <td><span class="badge ${r.status === "confirmed" ? "green" : "gold"}">${esc(r.status || "draft")}</span></td>
            <td>
              <button class="btn secondary small view-sales" data-id="${esc(r.id)}">View</button>
              ${r.status === "confirmed" ? "" : `<button class="btn green small process-sales" data-id="${esc(r.id)}">Process</button>`}
            </td>
          </tr>`;
        }).join("") || '<tr><td colspan="8" class="muted">No sales reports yet.</td></tr>'}
      </tbody>
    </table>
  `;
  document.querySelectorAll(".view-sales").forEach(btn => btn.onclick = () => openSalesDetails(reports.find(r => r.id === btn.dataset.id)));
  document.querySelectorAll(".process-sales").forEach(btn => btn.onclick = () => processSales(reports.find(r => r.id === btn.dataset.id)));
}

function componentsFor(menuItemId) {
  return components.filter(c => c.menu_item_id === menuItemId);
}

function openLoyverseSalesImportModal() {
  openModal(`
    <div class="modal-head"><h3>Import Loyverse Sales</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="loyverseSalesImportForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>From</label><input name="from" type="date" class="input" value="${today()}" required></div>
          <div><label>To</label><input name="to" type="date" class="input" value="${today()}" required></div>
          <div class="full"><label>Loyverse Token</label><input name="token" type="password" class="input" required autocomplete="off"></div>
        </div>
        <div class="muted" style="margin-top:10px">
          Receipts import as draft reports. Processing is separate so stock is deducted only after mappings are checked.
        </div>
        <div id="loyverseSalesImportStatus" class="muted" style="margin-top:12px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn">Import</button>
      </div>
    </form>
  `);

  $("loyverseSalesImportForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const token = fd.get("token");
    const from = fd.get("from");
    const to = fd.get("to");
    if (to < from) return toast("To date must be after From date.", "error");
    $("loyverseSalesImportStatus").textContent = "Reading receipts from Loyverse...";
    try {
      const result = await loyverseSync("import-sales", {
        token,
        from,
        to,
        branch_id: state.currentBranchId,
      });
      toast(`Imported ${result.imported || 0} Loyverse receipts${result.skipped_confirmed ? `, skipped ${result.skipped_confirmed} confirmed` : ""}.`, "ok");
      closeModal();
      renderSales();
    } catch (err) {
      $("loyverseSalesImportStatus").textContent = "";
      toast("Loyverse sales import failed: " + errText(err), "error");
    }
  };
}

function openSalesDetails(report) {
  if (!report) return;
  const reportLines = linesFor(report.id);
  openModal(`
    <div class="modal-head"><h3>${esc(reportNo(report))}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Date</div><div><b>${esc((report.report_date || "").slice(0, 10))}</b></div></div>
        <div class="card"><div class="stat-title">Source</div><div><b>${esc(report.source || "manual")}</b></div></div>
        <div class="card"><div class="stat-title">Items Sold</div><div><b>${qty(report.total_items_sold || 0)}</b></div></div>
        <div class="card"><div class="stat-title">Sales</div><div><b>${money(report.total_sales_amount || 0)}</b></div></div>
      </div>
      <div class="form-grid" style="margin-bottom:14px">
        <div><label>Receipt</label><input class="input" value="${esc(reportNo(report))}" disabled></div>
        <div><label>Payment</label><input class="input" value="${esc(report.payment_summary || "")}" disabled></div>
        <div><label>Status</label><input class="input" value="${esc(report.status || "draft")}" disabled></div>
        <div><label>Dining Option</label><input class="input" value="${esc(report.dining_option || "")}" disabled></div>
        <div class="full"><label>Notes</label><textarea class="input" rows="2" disabled>${esc(report.notes || "")}</textarea></div>
      </div>
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th><th>Mapping</th><th>Note</th></tr></thead>
        <tbody>
          ${reportLines.map(line => {
            const mi = menuItems.find(m => m.id === line.menu_item_id);
            return `<tr>
              <td>${esc(line.pos_item_name || menuName(mi))}</td>
              <td>${qty(line.qty_sold || 0)}</td>
              <td>${money(line.unit_price || 0)}</td>
              <td>${money(line.net_sales_amount || 0)}</td>
              <td>${mi ? `<span class="badge green">${esc(menuName(mi))}</span>` : '<span class="badge red">Not mapped</span>'}</td>
              <td>${esc(line.notes || "")}</td>
            </tr>`;
          }).join("") || '<tr><td colspan="6" class="muted">No lines.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
}

function menuOptions(selected) {
  return '<option value="">-- Select menu item --</option>' + menuItems.filter(m => m.active !== false || m.id === selected).map(m => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${esc(menuName(m))}</option>`).join("");
}

function openSalesModal() {
  let localLines = [{ menu_item_id: "", qty_sold: 1, unit_price: 0, notes: "" }];
  openModal(`
    <div class="modal-head"><h3>Manual Sales Entry</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="salesForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Sales Date</label><input name="report_date" type="date" class="input" value="${today()}" required></div>
          <div><label>Source</label><input name="source" class="input" value="manual"></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
        <div class="section-head" style="margin-top:18px"><h3 style="margin:0">Sold Menu Items</h3><button type="button" class="btn secondary small" id="addSalesLineBtn">+ Add Line</button></div>
        <div id="salesLinesBox"></div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save Draft</button></div>
    </form>
  `);
  function renderLines() {
    $("salesLinesBox").innerHTML = `
      <table>
        <thead><tr><th>Menu Item</th><th>Qty Sold</th><th>Unit Price</th><th>Deductions</th><th></th></tr></thead>
        <tbody>${localLines.map((l, idx) => {
          const mi = menuItems.find(m => m.id === l.menu_item_id);
          const comps = componentsFor(l.menu_item_id);
          return `<tr>
            <td><select class="sales-menu" data-idx="${idx}" style="min-width:240px">${menuOptions(l.menu_item_id)}</select></td>
            <td><input class="input sales-qty" data-idx="${idx}" type="number" step="0.001" value="${esc(l.qty_sold ?? "")}"></td>
            <td><input class="input sales-price" data-idx="${idx}" type="number" step="0.01" value="${esc(l.unit_price ?? mi?.sale_price ?? 0)}"></td>
            <td>${comps.length ? comps.map(c => `${esc(itemLabel(item(c.item_id)))} ${qty(Number(c.qty_per_portion || 0) * Number(l.qty_sold || 0))} ${esc(c.unit || "")}`).join("<br>") : '<span class="badge red">No mapping</span>'}</td>
            <td><button type="button" class="btn red small remove-sales-line" data-idx="${idx}">x</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    `;
    bindLineEvents();
  }
  function bindLineEvents() {
    document.querySelectorAll(".sales-menu").forEach(el => el.onchange = e => {
      const idx = Number(e.target.dataset.idx);
      const mi = menuItems.find(m => m.id === e.target.value);
      localLines[idx].menu_item_id = e.target.value;
      localLines[idx].unit_price = Number(mi?.sale_price || 0);
      renderLines();
    });
    document.querySelectorAll(".sales-qty").forEach(el => el.oninput = e => { localLines[Number(e.target.dataset.idx)].qty_sold = Number(e.target.value || 0); renderLines(); });
    document.querySelectorAll(".sales-price").forEach(el => el.oninput = e => localLines[Number(e.target.dataset.idx)].unit_price = Number(e.target.value || 0));
    document.querySelectorAll(".remove-sales-line").forEach(el => el.onclick = e => { localLines.splice(Number(e.target.dataset.idx), 1); if (!localLines.length) localLines.push({ menu_item_id: "", qty_sold: 1, unit_price: 0, notes: "" }); renderLines(); });
  }
  renderLines();
  $("addSalesLineBtn").onclick = () => { localLines.push({ menu_item_id: "", qty_sold: 1, unit_price: 0, notes: "" }); renderLines(); };
  $("salesForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const clean = localLines.filter(l => l.menu_item_id && Number(l.qty_sold || 0) !== 0);
    if (!clean.length) return toast("Add at least one sold menu item.", "error");
    try {
      const report = await insertRow("sales_reports", {
        branch_id: state.currentBranchId,
        report_date: fd.get("report_date"),
        status: "draft",
        source: fd.get("source") || "manual",
        notes: fd.get("notes") || null,
        total_items_sold: clean.reduce((s, l) => s + Number(l.qty_sold || 0), 0),
        total_sales_amount: clean.reduce((s, l) => s + Number(l.qty_sold || 0) * Number(l.unit_price || 0), 0),
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      const rows = clean.map(l => {
        const mi = menuItems.find(m => m.id === l.menu_item_id);
        return {
          report_id: report.id,
          menu_item_id: l.menu_item_id,
          qty_sold: Number(l.qty_sold || 0),
          previous_qty: 0,
          unit_price: Number(l.unit_price || 0),
          gross_sales_amount: Number(l.qty_sold || 0) * Number(l.unit_price || 0),
          net_sales_amount: Number(l.qty_sold || 0) * Number(l.unit_price || 0),
          pos_item_name: mi?.name || null,
          status: "draft",
          notes: l.notes || null,
        };
      });
      const { error } = await state.db.from("sales_report_lines").insert(rows);
      if (error) throw error;
      toast("Sales draft saved.", "ok");
      closeModal();
      renderSales();
    } catch (err) {
      toast("Sales save failed: " + errText(err), "error");
    }
  };
}

async function processSales(report) {
  if (!report || report.status === "confirmed") return;
  try {
    const reportLines = linesFor(report.id);
    for (const line of reportLines) {
      const comps = componentsFor(line.menu_item_id);
      if (!comps.length) throw new Error(`${line.pos_item_name || "Menu item"} has no deduction mapping.`);
      for (const comp of comps) {
        const si = item(comp.item_id);
        const amount = -Math.abs(Number(comp.qty_per_portion || 0) * Number(line.qty_sold || 0));
        const { error } = await state.db.from("stock_movements").insert({
          branch_id: state.currentBranchId,
          item_id: comp.item_id,
          movement_type: "SALES_DEDUCTION",
          qty_change: amount,
          qty: amount,
          quantity: amount,
          stock_unit: comp.unit || si?.stock_unit || "",
          unit: comp.unit || si?.stock_unit || "",
          reference_id: report.id,
          reference_type: "sales",
          notes: `Sales ${reportNo(report)}: ${line.pos_item_name || menuName(menuItems.find(m => m.id === line.menu_item_id))}`,
          created_by: state.user.id,
        });
        if (error) throw error;
      }
      await state.db.from("sales_report_lines").update({ status: "processed" }).eq("id", line.id);
    }
    await updateRow("sales_reports", report.id, { status: "confirmed", confirmed_by: state.user.id, processed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    toast("Sales processed and stock deducted.", "ok");
    renderSales();
  } catch (err) {
    toast("Sales processing failed: " + errText(err), "error");
  }
}
