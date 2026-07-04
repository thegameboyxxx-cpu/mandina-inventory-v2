import { state, isFullManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal, today, dateShift, formatDateTimeMelbourne } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";
import { loadItemDeps, loadItems } from "./items.js";
import { supplierName } from "./suppliers.js";

let items = [];
let suppliers = [];
let balances = [];
let purchaseOrders = [];
let purchaseOrderLines = [];
let receivingNotes = [];
let receivingLines = [];
let overReceivingAlerts = [];
let systemAlerts = [];
let wasteEntries = [];
let countLines = [];
let cashCounts = [];
let timeEntries = [];

let filters = { status: "open", type: "", search: "" };

const item = id => items.find(i => i.id === id);
const supplier = id => suppliers.find(s => s.id === id);
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";
const poNo = po => po?.po_number || `PO-${String(po?.id || "").slice(0, 8)}`;
const rnNo = rn => rn?.grn_number || rn?.receiving_number || `RN-${String(rn?.id || "").slice(0, 8)}`;
const currentQty = itemId => {
  const bal = balances.find(b => b.item_id === itemId);
  return Number(bal?.qty_on_hand ?? bal?.current_qty ?? bal?.quantity ?? 0);
};
const sameUnit = (a, b) => String(a || "").toLowerCase().trim() === String(b || "").toLowerCase().trim();

async function loadAlertData() {
  await loadItemDeps();
  await loadItems();
  items = state.items || [];
  suppliers = state.suppliers || [];
  balances = await safeSelect("stock_balances", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []);
  purchaseOrders = await safeSelect("purchase_orders", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  purchaseOrderLines = await safeSelect("purchase_order_lines", "*").catch(() => []);
  receivingNotes = await safeSelect("receiving_notes", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  receivingLines = await safeSelect("receiving_note_lines", "*").catch(() => []);
  overReceivingAlerts = await safeSelect("over_receiving_alerts", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  systemAlerts = await safeSelect("alerts", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  wasteEntries = await safeSelect("waste_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  countLines = await safeSelect("stock_count_lines", "*").catch(() => []);
  cashCounts = await safeSelect("cash_register_counts", "*", { eq: { branch_id: state.currentBranchId }, order: "count_date", ascending: false }).catch(() => []);
  timeEntries = await safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
}

export async function renderAlerts() {
  const content = $("content");
  if (!isFullManager()) {
    content.innerHTML = showError("Full manager access required.");
    return;
  }
  content.innerHTML = '<div class="card">Loading alerts...</div>';
  try {
    await loadAlertData();
    const alertRows = buildAlerts();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Alerts Center</h2>
          <div class="toolbar">
            <select id="alertStatusFilter">
              <option value="open">Open</option>
              <option value="">All</option>
              <option value="closed">Closed / Resolved</option>
            </select>
            <select id="alertTypeFilter">
              <option value="">All types</option>
              <option value="receiving">Receiving</option>
              <option value="stock">Stock</option>
              <option value="count">Daily Count</option>
              <option value="waste">Waste</option>
              <option value="cash">Cash</option>
              <option value="timeclock">Time Clock</option>
              <option value="system">System</option>
            </select>
            <input id="alertSearch" class="input" placeholder="Search alerts...">
            <button class="btn gold" id="createReorderPosBtn">Create Reorder POs</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Alerts read from the current branch. Actions that affect stock are limited to explicit manager decisions.</div>
        <div id="alertsSummary"></div>
        <div id="alertsTable" style="margin-top:14px"></div>
      </div>
    `;
    $("alertStatusFilter").value = filters.status;
    $("alertTypeFilter").value = filters.type;
    $("alertSearch").value = filters.search;
    $("alertStatusFilter").onchange = e => { filters.status = e.target.value; renderAlertsTable(alertRows); };
    $("alertTypeFilter").onchange = e => { filters.type = e.target.value; renderAlertsTable(alertRows); };
    $("alertSearch").oninput = e => { filters.search = e.target.value; renderAlertsTable(alertRows); };
    $("createReorderPosBtn").onclick = openReorderPoModal;
    renderAlertsTable(alertRows);
  } catch (err) {
    content.innerHTML = showError("Could not load alerts. " + err.message);
  }
}

export async function dashboardAlertSummary() {
  await loadAlertData();
  const alerts = buildAlerts();
  const open = alerts.filter(a => a.open);
  return {
    openAlerts: open.length,
    criticalAlerts: open.filter(a => a.priority === "Critical").length,
    lowStock: lowStockItems().length,
    repeatedWaste: repeatedWasteAlerts().length,
    cashIssues: cashAlerts().length,
    topAlerts: open.slice(0, 6),
  };
}

function buildAlerts() {
  return [
    ...receivingAlerts(),
    ...lowStockAlerts(),
    ...countVarianceAlerts(),
    ...repeatedWasteAlerts(),
    ...cashAlerts(),
    ...timeClockAlerts(),
    ...genericSystemAlerts(),
  ].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || new Date(b.date || 0) - new Date(a.date || 0));
}

function receivingAlerts() {
  const rows = [];
  for (const alert of overReceivingAlerts) {
    const status = String(alert.status || "open").toLowerCase();
    const it = item(alert.item_id);
    const rn = receivingNotes.find(n => n.id === alert.receiving_note_id);
    const po = purchaseOrders.find(p => p.id === alert.purchase_order_id);
    rows.push({
      id: `over-${alert.id}`,
      source: "over_receiving_alerts",
      sourceId: alert.id,
      type: "receiving",
      priority: "High",
      title: `Over received: ${itemLabel(it)}`,
      detail: `${qty(alert.over_qty)} ${alert.unit || it?.receiving_unit || ""} over ${poNo(po)} / ${rnNo(rn)}`,
      date: alert.created_at || rn?.created_at,
      status,
      open: !["accepted", "rejected", "closed", "resolved", "dismissed"].includes(status),
      actions: ["accept_over", "reject_over", "close_over"],
      raw: alert,
    });
  }
  for (const issue of underReceivingIssues()) {
    rows.push({
      id: `under-${issue.line.id}`,
      type: "receiving",
      priority: "Medium",
      title: `Under received: ${itemLabel(issue.item)}`,
      detail: `${qty(issue.shortQty)} ${issue.unit} still not received from ${poNo(issue.po)} / ${rnNo(issue.note)}`,
      date: issue.note.created_at || issue.note.received_date,
      status: "open",
      open: true,
      actions: ["info"],
      raw: issue,
    });
  }
  return rows;
}

function underReceivingIssues() {
  const issues = [];
  for (const line of receivingLines) {
    const note = receivingNotes.find(n => n.id === (line.grn_id || line.receiving_note_id));
    if (!note) continue;
    const po = purchaseOrders.find(p => p.id === (note.po_id || note.purchase_order_id || line.purchase_order_id));
    if (!po) continue;
    const poLine = purchaseOrderLines.find(l => l.id === (line.po_line_id || line.purchase_order_line_id));
    const ordered = Number(line.ordered_qty || poLine?.ordered_qty || 0);
    const accepted = Number(line.accepted_qty || 0);
    const rejected = Number(line.rejected_qty || 0);
    const shortQty = Math.max(0, ordered - accepted);
    if (shortQty <= 0 || rejected <= 0 && accepted >= ordered) continue;
    issues.push({
      line,
      note,
      po,
      item: item(line.item_id),
      shortQty,
      unit: line.receive_unit || line.order_unit || poLine?.order_unit || "",
    });
  }
  return issues.slice(0, 30);
}

function lowStockItems() {
  return items
    .filter(i => i.active !== false && (i.item_type || "raw") === "raw")
    .filter(i => Number(i.reorder_level || 0) > 0 && currentQty(i.id) <= Number(i.reorder_level || 0))
    .sort((a, b) => (currentQty(a.id) - Number(a.reorder_level || 0)) - (currentQty(b.id) - Number(b.reorder_level || 0)));
}

function lowStockAlerts() {
  return lowStockItems().map(i => ({
    id: `low-${i.id}`,
    type: "stock",
    priority: currentQty(i.id) <= 0 ? "Critical" : "High",
    title: `Low stock: ${itemLabel(i)}`,
    detail: `${qty(currentQty(i.id))} ${i.stock_unit || ""} on hand. Reorder level ${qty(i.reorder_level)} ${i.stock_unit || ""}.`,
    date: new Date().toISOString(),
    status: "open",
    open: true,
    actions: ["reorder"],
    raw: i,
  }));
}

function countVarianceAlerts() {
  const rows = countLines
    .map(line => {
      const variance = Number((line.approved_adjustment_qty ?? line.variance ?? (Number(line.counted_qty || 0) - Number(line.expected_qty || 0))) || 0);
      const it = item(line.item_id);
      const approxCost = Math.abs(variance) * Number(it?.default_purchase_price || it?.unit_cost || 0);
      return { line, it, variance, approxCost };
    })
    .filter(row => row.it && Math.abs(row.variance) > 0)
    .filter(row => Math.abs(row.variance) >= 5 || row.approxCost >= 50)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, 20);
  return rows.map(row => ({
    id: `count-${row.line.id}`,
    type: "count",
    priority: row.approxCost >= 100 || Math.abs(row.variance) >= 20 ? "High" : "Medium",
    title: `Count variance: ${itemLabel(row.it)}`,
    detail: `${row.variance > 0 ? "Over" : "Short"} by ${qty(Math.abs(row.variance))} ${row.line.count_unit || row.it.stock_unit || ""}${row.approxCost ? `, approx ${money(row.approxCost)}` : ""}`,
    date: row.line.updated_at || row.line.created_at,
    status: "open",
    open: true,
    actions: ["info"],
    raw: row.line,
  }));
}

function repeatedWasteAlerts() {
  const since = dateShift(today(), -6);
  const active = wasteEntries.filter(w => (w.status || "recorded") !== "cancelled" && String(w.waste_date || w.created_at || "").slice(0, 10) >= since);
  const byItem = new Map();
  for (const w of active) {
    const key = w.item_id;
    const prev = byItem.get(key) || { entries: 0, cost: 0, qty: 0, lastDate: "" };
    prev.entries += 1;
    prev.cost += Number(w.estimated_cost || 0);
    prev.qty += Number(w.qty || 0);
    prev.lastDate = [prev.lastDate, String(w.waste_date || w.created_at || "").slice(0, 10)].sort().pop();
    byItem.set(key, prev);
  }
  return [...byItem.entries()]
    .map(([itemId, data]) => ({ it: item(itemId), data }))
    .filter(row => row.it && (row.data.entries >= 3 || row.data.cost >= 50))
    .sort((a, b) => b.data.cost - a.data.cost || b.data.entries - a.data.entries)
    .map(row => ({
      id: `waste-${row.it.id}`,
      type: "waste",
      priority: row.data.cost >= 100 || row.data.entries >= 5 ? "High" : "Medium",
      title: `Repeated waste: ${itemLabel(row.it)}`,
      detail: `${row.data.entries} entries in last 7 days, ${qty(row.data.qty)} ${row.it.stock_unit || ""}, ${money(row.data.cost)} estimated cost.`,
      date: row.data.lastDate,
      status: "open",
      open: true,
      actions: ["info"],
      raw: row,
    }));
}

function cashAlerts() {
  return cashCounts
    .map(c => ({ c, diff: Number(c.difference ?? (Number(c.actual_cash || 0) - Number(c.expected_cash || 0))) }))
    .filter(row => Math.abs(row.diff) > 0 && row.c.status !== "voided")
    .slice(0, 20)
    .map(row => ({
      id: `cash-${row.c.id}`,
      type: "cash",
      priority: Math.abs(row.diff) >= 50 ? "High" : "Medium",
      title: `Cash ${row.diff > 0 ? "over" : "short"}: ${money(Math.abs(row.diff))}`,
      detail: `${row.c.count_date}: expected ${money(row.c.expected_cash)}, counted ${money(row.c.actual_cash)}. ${row.c.reason || ""}`,
      date: row.c.count_date || row.c.created_at,
      status: "open",
      open: true,
      actions: ["info"],
      raw: row.c,
    }));
}

function timeClockAlerts() {
  return timeEntries
    .filter(e => e.status === "clocked_in" && e.clock_in_at && (new Date() - new Date(e.clock_in_at)) / 3600000 >= 10)
    .map(e => ({
      id: `clock-open-${e.id}`,
      type: "timeclock",
      priority: "Medium",
      title: "Long open clock-in",
      detail: `Clocked in since ${formatDateTimeMelbourne(e.clock_in_at)}.`,
      date: e.clock_in_at,
      status: "open",
      open: true,
      actions: ["info"],
      raw: e,
    }));
}

function genericSystemAlerts() {
  return systemAlerts.map(a => {
    const status = String(a.status || "open").toLowerCase();
    return {
      id: `system-${a.id}`,
      source: "alerts",
      sourceId: a.id,
      type: systemAlertType(a),
      priority: a.priority || "Medium",
      title: a.title || a.alert_type || "System alert",
      detail: detailText(a.detail) || a.message || a.notes || "",
      date: a.created_at,
      status,
      open: !["closed", "resolved", "dismissed"].includes(status),
      actions: ["close_system"],
      raw: a,
    };
  });
}

function systemAlertType(alert) {
  const type = String(alert.alert_type || alert.reference_type || "").toLowerCase();
  if (type.includes("clock") || type.includes("time")) return "timeclock";
  if (type.includes("production")) return "system";
  return "system";
}

function renderAlertsTable(alertRows) {
  const q = filters.search.trim().toLowerCase();
  const rows = alertRows
    .filter(a => !filters.type || a.type === filters.type)
    .filter(a => !filters.status || (filters.status === "open" ? a.open : !a.open))
    .filter(a => !q || `${a.title} ${a.detail} ${a.type} ${a.priority} ${a.status}`.toLowerCase().includes(q));
  const open = alertRows.filter(a => a.open);
  const byPriority = open.reduce((acc, a) => {
    acc[a.priority] = (acc[a.priority] || 0) + 1;
    return acc;
  }, {});
  $("alertsSummary").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="card"><div class="stat-title">Open Alerts</div><div><b>${open.length}</b></div></div>
      <div class="card"><div class="stat-title">Critical</div><div><b>${byPriority.Critical || 0}</b></div></div>
      <div class="card"><div class="stat-title">High</div><div><b>${byPriority.High || 0}</b></div></div>
      <div class="card"><div class="stat-title">Low Stock</div><div><b>${lowStockItems().length}</b></div></div>
      <div class="card"><div class="stat-title">Repeated Waste</div><div><b>${repeatedWasteAlerts().length}</b></div></div>
    </div>
  `;
  $("alertsTable").innerHTML = `
    <table>
      <thead><tr><th>Priority</th><th>Type</th><th>Alert</th><th>Status</th><th>Date</th><th></th></tr></thead>
      <tbody>
        ${rows.map(a => `<tr>
          <td><span class="badge ${priorityClass(a.priority)}">${esc(a.priority)}</span></td>
          <td>${esc(typeLabel(a.type))}</td>
          <td><b>${esc(a.title)}</b><div class="muted">${esc(a.detail)}</div></td>
          <td>${statusBadge(a)}</td>
          <td>${esc(dateText(a.date))}</td>
          <td>${actionButtons(a)}</td>
        </tr>`).join("") || '<tr><td colspan="6" class="muted">No alerts match this filter.</td></tr>'}
      </tbody>
    </table>
  `;
  document.querySelectorAll(".alert-accept-over").forEach(btn => btn.onclick = () => acceptOverReceiving(alertRows.find(a => a.id === btn.dataset.id)));
  document.querySelectorAll(".alert-reject-over").forEach(btn => btn.onclick = () => rejectOverReceiving(alertRows.find(a => a.id === btn.dataset.id)));
  document.querySelectorAll(".alert-close").forEach(btn => btn.onclick = () => closeAlert(alertRows.find(a => a.id === btn.dataset.id)));
  document.querySelectorAll(".alert-reorder").forEach(btn => btn.onclick = openReorderPoModal);
}

function actionButtons(alert) {
  if (alert.actions.includes("accept_over") && alert.open) {
    return `
      <button class="btn green small alert-accept-over" data-id="${esc(alert.id)}">Accept</button>
      <button class="btn red small alert-reject-over" data-id="${esc(alert.id)}">Reject</button>
      <button class="btn secondary small alert-close" data-id="${esc(alert.id)}">Investigated</button>
    `;
  }
  if (alert.actions.includes("reorder")) return `<button class="btn gold small alert-reorder" data-id="${esc(alert.id)}">Create POs</button>`;
  if (alert.actions.includes("close_system") && alert.open) return `<button class="btn secondary small alert-close" data-id="${esc(alert.id)}">Investigated</button>`;
  return `<span class="muted">No action needed</span>`;
}

async function acceptOverReceiving(alert) {
  if (!alert?.raw) return;
  await setAlertStatus("over_receiving_alerts", alert.sourceId, "accepted", { resolved_by: state.user.id, resolved_at: new Date().toISOString() });
  toast("Over receiving accepted. Stock remains as received.", "ok");
  renderAlerts();
}

async function rejectOverReceiving(alert) {
  if (!alert?.raw) return;
  if (!confirm("Reject this over-received quantity? The system will reverse only the extra stock quantity.")) return;
  const raw = alert.raw;
  const it = item(raw.item_id);
  const reverseQty = -Math.abs(Number(raw.over_qty || 0) * itemConversionFactor(it));
  try {
    const { error } = await state.db.from("stock_movements").insert({
      branch_id: state.currentBranchId,
      item_id: raw.item_id,
      movement_type: "MANAGER_ADJUSTMENT",
      qty_change: reverseQty,
      qty: reverseQty,
      quantity: reverseQty,
      stock_unit: it?.stock_unit || raw.unit || "",
      unit: it?.stock_unit || raw.unit || "",
      reference_id: raw.id,
      reference_type: "over_receiving_rejection",
      notes: `Rejected over receiving: ${qty(raw.over_qty)} ${raw.unit || ""}`,
      created_by: state.user.id,
    });
    if (error) throw error;
    await setAlertStatus("over_receiving_alerts", raw.id, "rejected", { resolved_by: state.user.id, resolved_at: new Date().toISOString() });
    toast("Over receiving rejected and extra stock reversed.", "ok");
    renderAlerts();
  } catch (err) {
    toast("Reject failed: " + err.message, "error");
  }
}

async function closeAlert(alert) {
  if (!alert) return;
  const table = alert.source || (alert.id.startsWith("system-") ? "alerts" : null);
  if (!table || !alert.sourceId) return toast("This alert is calculated from live data and closes when the underlying issue is fixed.", "info");
  await setAlertStatus(table, alert.sourceId, "closed", { resolved_by: state.user.id, resolved_at: new Date().toISOString() });
  toast("Alert marked investigated.", "ok");
  renderAlerts();
}

async function setAlertStatus(table, id, status, extra = {}) {
  const payload = { status, updated_at: new Date().toISOString(), ...extra };
  const { error } = await state.db.from(table).update(payload).eq("id", id);
  if (error) {
    const fallback = { status };
    const retry = await state.db.from(table).update(fallback).eq("id", id);
    if (retry.error) throw retry.error;
  }
}

function openReorderPoModal() {
  const groups = reorderGroups();
  const supplierGroups = groups.filter(g => g.supplier);
  const missing = groups.filter(g => !g.supplier).flatMap(g => g.items);
  openModal(`
    <div class="modal-head"><h3>Create Reorder Purchase Orders</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="muted" style="margin-bottom:12px">The system creates one draft PO per supplier. Order quantity is based on the item's reorder level and converted to receiving unit when package conversion is available.</div>
      ${supplierGroups.map(group => `
        <div class="card" style="margin-bottom:12px">
          <div class="section-head"><h3 style="margin:0">${esc(supplierName(group.supplier))}</h3><span class="badge gold">${group.items.length} items</span></div>
          <table><thead><tr><th>Item</th><th>Current</th><th>Reorder Level</th><th>PO Qty</th><th>Unit</th></tr></thead><tbody>
            ${group.items.map(row => `<tr>
              <td>${esc(itemLabel(row.item))}</td>
              <td>${qty(row.current)} ${esc(row.item.stock_unit || "")}</td>
              <td>${qty(row.item.reorder_level)} ${esc(row.item.stock_unit || "")}</td>
              <td><b>${qty(row.orderQty)}</b></td>
              <td>${esc(row.orderUnit)}</td>
            </tr>`).join("")}
          </tbody></table>
        </div>
      `).join("") || '<div class="muted">No low-stock items have suppliers assigned.</div>'}
      ${missing.length ? `<div class="card"><h3 style="margin-top:0">Needs Supplier</h3><table><thead><tr><th>Item</th><th>Current</th><th>Reorder Level</th></tr></thead><tbody>${missing.map(row => `<tr><td>${esc(itemLabel(row.item))}</td><td>${qty(row.current)} ${esc(row.item.stock_unit || "")}</td><td>${qty(row.item.reorder_level)} ${esc(row.item.stock_unit || "")}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">Cancel</button>
      ${supplierGroups.length ? '<button class="btn green" id="confirmCreateReorderPos">Create Draft POs</button>' : ""}
    </div>
  `);
  if ($("confirmCreateReorderPos")) $("confirmCreateReorderPos").onclick = () => createReorderPurchaseOrders(supplierGroups);
}

function reorderGroups() {
  const bySupplier = new Map();
  for (const i of lowStockItems()) {
    const sup = supplier(i.primary_supplier_id);
    const key = sup?.id || "missing";
    const group = bySupplier.get(key) || { supplier: sup, items: [] };
    group.items.push({ item: i, current: currentQty(i.id), ...orderQtyForItem(i) });
    bySupplier.set(key, group);
  }
  return [...bySupplier.values()];
}

async function createReorderPurchaseOrders(groups) {
  try {
    let created = 0;
    for (const group of groups) {
      if (!group.supplier || !group.items.length) continue;
      const total = group.items.reduce((sum, row) => sum + (sameUnit(row.orderUnit, row.costUnit) ? row.orderQty * row.price : 0), 0);
      const po = await insertRow("purchase_orders", {
        branch_id: state.currentBranchId,
        supplier_id: group.supplier.id,
        status: "draft",
        order_date: today(),
        delivery_asap: true,
        notes: "Auto-created from Alerts low stock reorder.",
        total_amount: total,
        po_number: `PO-${Date.now().toString().slice(-8)}-${created + 1}`,
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      const lines = group.items.map((row, index) => ({
        purchase_order_id: po.id,
        item_id: row.item.id,
        ordered_qty: row.orderQty,
        unit: row.orderUnit,
        order_unit: row.orderUnit,
        cost_unit: row.costUnit,
        unit_price: row.price,
        notes: `Reorder level ${qty(row.item.reorder_level)} ${row.item.stock_unit || ""}; current ${qty(row.current)} ${row.item.stock_unit || ""}`,
        sort_order: index,
      }));
      const { error } = await state.db.from("purchase_order_lines").insert(lines);
      if (error) throw error;
      created += 1;
    }
    toast(`Created ${created} draft purchase order${created === 1 ? "" : "s"}.`, "ok");
    closeModal();
    renderAlerts();
  } catch (err) {
    toast("Create reorder POs failed: " + err.message, "error");
  }
}

function orderQtyForItem(it) {
  const reorderLevel = Number(it.reorder_level || 0);
  const orderUnit = it.receiving_unit || it.purchase_package_type || it.stock_unit || "";
  const costUnit = it.cost_unit || it.stock_unit || orderUnit;
  const price = Number(it.default_purchase_price || 0);
  let orderQty = reorderLevel;
  const packageQty = Number(it.purchase_package_qty || it.package_quantity || 0);
  const packageUnit = it.purchase_package_unit || "";
  if (!sameUnit(orderUnit, it.stock_unit) && packageQty > 0 && (!packageUnit || sameUnit(packageUnit, it.stock_unit))) {
    orderQty = Math.ceil(reorderLevel / packageQty);
  }
  return { orderQty: Math.max(0, orderQty), orderUnit, costUnit, price };
}

function itemConversionFactor(it) {
  const receivingUnit = it?.receiving_unit || it?.purchase_package_type || "";
  const stockUnit = it?.stock_unit || "";
  const pkgUnit = it?.purchase_package_unit || "";
  const pkgQty = Number(it?.purchase_package_qty || it?.package_quantity || 0);
  if (receivingUnit && stockUnit && !sameUnit(receivingUnit, stockUnit) && pkgQty > 0) {
    if (!pkgUnit || sameUnit(pkgUnit, stockUnit)) return pkgQty;
  }
  return 1;
}

function detailText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function typeLabel(type) {
  return ({
    receiving: "Receiving",
    stock: "Stock",
    count: "Daily Count",
    waste: "Waste",
    cash: "Cash",
    timeclock: "Time Clock",
    system: "System",
  })[type] || type || "Alert";
}

function priorityRank(priority) {
  return ({ Low: 1, Medium: 2, High: 3, Critical: 4 })[priority] || 2;
}

function priorityClass(priority) {
  if (priority === "Critical") return "red";
  if (priority === "High") return "red";
  if (priority === "Medium") return "gold";
  return "blue";
}

function statusBadge(alert) {
  const cls = alert.open ? "gold" : "green";
  return `<span class="badge ${cls}">${esc(alert.open ? "Open" : alert.status || "Closed")}</span>`;
}

function dateText(value) {
  if (!value) return "-";
  if (String(value).length === 10) return String(value);
  return formatDateTimeMelbourne(value);
}
