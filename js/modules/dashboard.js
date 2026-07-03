import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, today } from "../utils.js";
import { safeSelect } from "../services/db.js";
import { dashboardAlertSummary } from "./alerts.js";

export async function renderDashboard() {
  const content = $("content");
  content.innerHTML = '<div class="card">Loading dashboard...</div>';
  try {
    const [summary, ops] = await Promise.all([
      isManager() ? dashboardAlertSummary().catch(() => null) : Promise.resolve(null),
      loadOperationalSummary(),
    ]);

    content.innerHTML = `
      <div class="grid cards" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:16px">
        <div class="card"><div class="stat-title">Open Alerts</div><div class="stat-value">${summary?.openAlerts ?? "-"}</div></div>
        <div class="card"><div class="stat-title">Critical Alerts</div><div class="stat-value">${summary?.criticalAlerts ?? "-"}</div></div>
        <div class="card"><div class="stat-title">Low Stock</div><div class="stat-value">${summary?.lowStock ?? ops.lowStock}</div></div>
        <div class="card"><div class="stat-title">Clocked In</div><div class="stat-value">${ops.clockedIn}</div></div>
        <div class="card"><div class="stat-title">Waste Today</div><div class="stat-value">${money(ops.wasteToday)}</div></div>
        <div class="card"><div class="stat-title">Cash Issues</div><div class="stat-value">${summary?.cashIssues ?? ops.cashIssues}</div></div>
      </div>

      ${isManager() ? renderAlertPanel(summary) : ""}

      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
        <div class="card">
          <div class="section-head"><h2>Today Snapshot</h2></div>
          <table>
            <tbody>
              <tr><th>Sales Reports Today</th><td>${ops.salesToday}</td></tr>
              <tr><th>Production Today</th><td>${ops.productionToday}</td></tr>
              <tr><th>Daily Counts Pending</th><td>${ops.countsPending}</td></tr>
              <tr><th>Staff Meals Pending</th><td>${ops.staffMealsPending}</td></tr>
              <tr><th>Payroll Due</th><td>${money(ops.payrollDue)}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="section-head"><h2>Quick Actions</h2></div>
          <div class="toolbar" style="gap:8px;align-items:stretch">
            ${quickButton("alerts", "Alerts")}
            ${quickButton("purchase", "New PO")}
            ${quickButton("receiving", "Receive")}
            ${quickButton("production", "Production")}
            ${quickButton("counts", "Daily Count")}
            ${quickButton("waste", "Waste")}
            ${quickButton("sales", "Sales")}
          </div>
        </div>
      </div>
    `;
    document.querySelectorAll("[data-dashboard-page]").forEach(btn => {
      btn.onclick = () => document.querySelector(`#nav button[data-page="${CSS.escape(btn.dataset.dashboardPage)}"]`)?.click();
    });
  } catch (err) {
    content.innerHTML = showError("Could not load dashboard. " + err.message);
  }
}

function renderAlertPanel(summary) {
  const rows = summary?.topAlerts || [];
  return `
    <div class="card" style="margin-bottom:16px">
      <div class="section-head">
        <h2>Critical Attention</h2>
        <button class="btn secondary small" data-dashboard-page="alerts">Open Alerts</button>
      </div>
      <table>
        <thead><tr><th>Priority</th><th>Type</th><th>Alert</th></tr></thead>
        <tbody>
          ${rows.map(a => `<tr>
            <td><span class="badge ${a.priority === "Critical" || a.priority === "High" ? "red" : "gold"}">${esc(a.priority)}</span></td>
            <td>${esc(a.type)}</td>
            <td><b>${esc(a.title)}</b><div class="muted">${esc(a.detail)}</div></td>
          </tr>`).join("") || '<tr><td colspan="3" class="muted">No open alerts right now.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

async function loadOperationalSummary() {
  const [
    items,
    balances,
    sales,
    production,
    counts,
    waste,
    meals,
    timeEntries,
    cashCounts,
    payrollPayments,
  ] = await Promise.all([
    safeSelect("items", "*").catch(() => []),
    safeSelect("stock_balances", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("sales_reports", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("production_batches", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("stock_counts", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("waste_entries", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("staff_meals", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("cash_register_counts", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
    safeSelect("payroll_payments", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []),
  ]);
  const currentQty = itemId => {
    const bal = balances.find(b => b.item_id === itemId);
    return Number(bal?.qty_on_hand ?? bal?.current_qty ?? bal?.quantity ?? 0);
  };
  const lowStock = items.filter(i => i.active !== false && Number(i.reorder_level || 0) > 0 && currentQty(i.id) <= Number(i.reorder_level || 0)).length;
  const day = today();
  const wasteToday = waste
    .filter(w => (w.status || "recorded") !== "cancelled" && String(w.waste_date || w.created_at || "").slice(0, 10) === day)
    .reduce((sum, w) => sum + Number(w.estimated_cost || 0), 0);
  const cashIssues = cashCounts.filter(c => c.status !== "voided" && Number(c.difference ?? (Number(c.actual_cash || 0) - Number(c.expected_cash || 0))) !== 0).length;
  const payrollDue = payrollPayments
    .filter(p => p.status !== "voided")
    .reduce((sum, p) => sum + Math.max(0, Number(p.net_pay || 0) - Number(p.payment_amount || 0)), 0);
  return {
    lowStock,
    salesToday: sales.filter(s => String(s.report_date || s.created_at || "").slice(0, 10) === day).length,
    productionToday: production.filter(p => String(p.production_date || p.created_at || "").slice(0, 10) === day).length,
    countsPending: counts.filter(c => c.status === "submitted").length,
    staffMealsPending: meals.filter(m => m.status === "submitted").length,
    wasteToday,
    clockedIn: timeEntries.filter(e => e.status === "clocked_in").length,
    cashIssues,
    payrollDue,
  };
}

function quickButton(page, label) {
  return `<button class="btn secondary" data-dashboard-page="${esc(page)}">${esc(label)}</button>`;
}
