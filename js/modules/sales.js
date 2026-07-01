import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal, today } from "../utils.js";
import { safeSelect, insertRow, updateRow, deleteRows } from "../services/db.js";
import { loadItems } from "./items.js";

let reports = [];
let lines = [];
let menuItems = [];
let components = [];

const menuName = m => m ? `${m.name}${m.name_ar ? " / " + m.name_ar : ""}` : "Menu Item";
const item = id => (state.items || []).find(i => i.id === id);
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";
const reportNo = r => `SR-${String(r?.id || "").slice(0, 8)}`;

async function loadSalesData() {
  await loadItems();
  reports = await safeSelect("sales_reports", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  lines = await safeSelect("sales_report_lines", "*").catch(() => []);
  menuItems = await safeSelect("menu_items", "*", { order: "name" }).catch(() => []);
  components = await safeSelect("menu_item_components", "*", { order: "sort_order" }).catch(() => []);
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
          <div class="toolbar"><button class="btn" id="newSalesBtn">+ Manual Sales Entry</button></div>
        </div>
        <div class="muted" style="margin-bottom:12px">Manual sales use Menu Item deduction mappings to create SALES_DEDUCTION stock movements.</div>
        <div id="salesTable"></div>
      </div>
    `;
    $("newSalesBtn").onclick = openSalesModal;
    renderSalesTable();
  } catch (e) {
    content.innerHTML = showError("Could not load Sales. " + e.message);
  }
}

function linesFor(reportId) {
  return lines.filter(l => l.report_id === reportId);
}

function renderSalesTable() {
  $("salesTable").innerHTML = `
    <table>
      <thead><tr><th>Report</th><th>Date</th><th>Lines</th><th>Items Sold</th><th>Sales Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${reports.map(r => {
          const reportLines = linesFor(r.id);
          return `<tr>
            <td><b>${esc(reportNo(r))}</b><div class="muted">${esc(r.notes || "")}</div></td>
            <td>${esc((r.report_date || "").slice(0, 10))}</td>
            <td>${reportLines.length}</td>
            <td>${qty(r.total_items_sold || reportLines.reduce((s, l) => s + Number(l.qty_sold || 0), 0))}</td>
            <td>${money(r.total_sales_amount || reportLines.reduce((s, l) => s + Number(l.net_sales_amount || 0), 0))}</td>
            <td><span class="badge ${r.status === "confirmed" ? "green" : "gold"}">${esc(r.status || "draft")}</span></td>
            <td>${r.status === "confirmed" ? "" : `<button class="btn green small process-sales" data-id="${esc(r.id)}">Process</button>`}</td>
          </tr>`;
        }).join("") || '<tr><td colspan="7" class="muted">No sales reports yet.</td></tr>'}
      </tbody>
    </table>
  `;
  document.querySelectorAll(".process-sales").forEach(btn => btn.onclick = () => processSales(reports.find(r => r.id === btn.dataset.id)));
}

function componentsFor(menuItemId) {
  return components.filter(c => c.menu_item_id === menuItemId);
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
      toast("Sales save failed: " + err.message, "error");
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
    toast("Sales processing failed: " + err.message, "error");
  }
}
