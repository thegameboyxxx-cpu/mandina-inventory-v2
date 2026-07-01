import { state } from "../state.js";
import { $, esc, qty, showError } from "../utils.js";
import { safeSelect } from "../services/db.js";
import { loadItemDeps, loadItems } from "./items.js";

let balances = [];
let movements = [];
let stockFilters = { search: "", status: "" };

const itemLabel = item => item ? `${item.name}${item.name_ar ? " / " + item.name_ar : ""}` : "Item";
const itemType = item => item?.item_type || "raw";
const itemTypeBadge = item => itemType(item) === "produced"
  ? '<span class="badge green">Produced</span>'
  : '<span class="badge gold">Raw</span>';
const currentQty = itemId => {
  const bal = balances.find(b => b.item_id === itemId);
  return Number(bal?.qty_on_hand ?? bal?.current_qty ?? bal?.quantity ?? 0);
};
const categoryName = id => state.categories.find(c => c.id === id)?.name || "";
const stockStatus = item => {
  const amount = currentQty(item.id);
  const reorder = Number(item.reorder_level || 0);
  if (amount <= 0) return { key: "out", label: "Out", cls: "red" };
  if (reorder > 0 && amount <= reorder) return { key: "low", label: "Low", cls: "gold" };
  return { key: "ok", label: "OK", cls: "green" };
};

async function loadStockData() {
  await loadItemDeps();
  await loadItems();
  balances = await safeSelect("stock_balances", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []);
  movements = await safeSelect("stock_movements", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
}

export async function renderStock() {
  const content = $("content");
  content.innerHTML = `<div class="card">Loading stock...</div>`;

  try {
    await loadStockData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Stock</h2>
          <div class="toolbar">
            <input id="stockSearch" class="input" placeholder="Search item...">
            <select id="stockStatusFilter">
              <option value="">All stock</option>
              <option value="ok">OK</option>
              <option value="low">Low</option>
              <option value="out">Out</option>
            </select>
            <button class="btn secondary" id="stockRefreshBtn">Refresh</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">
          Branch: <b>${esc(branchName())}</b>. This page reads stock from stock movements, so production changes should appear here after refresh.
        </div>
        <div id="stockSummary"></div>
        <div id="stockTable" style="margin-top:14px"></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Recent Stock Movements</h2></div>
        <div id="stockMovements"></div>
      </div>
    `;

    $("stockSearch").value = stockFilters.search;
    $("stockStatusFilter").value = stockFilters.status;
    $("stockSearch").oninput = e => { stockFilters.search = e.target.value; renderStockTables(); };
    $("stockStatusFilter").onchange = e => { stockFilters.status = e.target.value; renderStockTables(); };
    $("stockRefreshBtn").onclick = renderStock;
    renderStockTables();
  } catch (e) {
    content.innerHTML = showError("Could not load stock. " + e.message);
  }
}

function branchName() {
  const b = (state.branches || []).find(x => x.id === state.currentBranchId) || {};
  return b.name || b.branch_name || b.title || state.currentBranchId || "";
}

function renderStockTables() {
  const q = stockFilters.search.toLowerCase();
  const rows = (state.items || [])
    .filter(item => item.active !== false)
    .filter(item => !q || JSON.stringify(item).toLowerCase().includes(q))
    .filter(item => !stockFilters.status || stockStatus(item).key === stockFilters.status)
    .sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));

  const counts = (state.items || []).filter(i => i.active !== false).reduce((acc, item) => {
    acc[stockStatus(item).key] += 1;
    return acc;
  }, { ok: 0, low: 0, out: 0 });

  $("stockSummary").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      <div class="card"><div class="stat-title">Active Items</div><div><b>${(state.items || []).filter(i => i.active !== false).length}</b></div></div>
      <div class="card"><div class="stat-title">OK</div><div><b>${counts.ok}</b></div></div>
      <div class="card"><div class="stat-title">Low</div><div><b>${counts.low}</b></div></div>
      <div class="card"><div class="stat-title">Out</div><div><b>${counts.out}</b></div></div>
    </div>
  `;

  $("stockTable").innerHTML = `
    <table>
      <thead><tr><th>Item</th><th>Type</th><th>Category</th><th>Current Stock</th><th>Stock Unit</th><th>Reorder Level</th><th>Status</th></tr></thead>
      <tbody>
        ${rows.map(item => {
          const status = stockStatus(item);
          return `<tr>
            <td><b>${esc(itemLabel(item))}</b></td>
            <td>${itemTypeBadge(item)}</td>
            <td>${esc(categoryName(item.category_id))}</td>
            <td><b>${qty(currentQty(item.id))}</b></td>
            <td>${esc(item.stock_unit || "")}</td>
            <td>${qty(item.reorder_level || 0)} ${esc(item.stock_unit || "")}</td>
            <td><span class="badge ${status.cls}">${esc(status.label)}</span></td>
          </tr>`;
        }).join("") || `<tr><td colspan="7" class="muted">No stock items found.</td></tr>`}
      </tbody>
    </table>
  `;

  $("stockMovements").innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>Item</th><th>Movement</th><th>Qty</th><th>Unit</th><th>Reference</th><th>Notes</th></tr></thead>
      <tbody>
        ${movements.slice(0, 30).map(m => {
          const item = state.items.find(i => i.id === m.item_id);
          return `<tr>
            <td>${esc((m.created_at || "").slice(0, 19).replace("T", " "))}</td>
            <td>${esc(itemLabel(item))}</td>
            <td>${esc(m.movement_type || "")}</td>
            <td><b>${qty(m.qty_change ?? m.qty ?? m.quantity ?? 0)}</b></td>
            <td>${esc(m.stock_unit || m.unit || "")}</td>
            <td>${esc(m.reference_type || "")}</td>
            <td>${esc(m.notes || "")}</td>
          </tr>`;
        }).join("") || `<tr><td colspan="7" class="muted">No stock movements yet.</td></tr>`}
      </tbody>
    </table>
  `;
}
