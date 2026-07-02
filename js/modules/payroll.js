import { state, isManager } from "../state.js";
import { $, esc, money, showError, toast, today } from "../utils.js";
import { safeSelect, insertRow } from "../services/db.js";

let employees = [];
let entries = [];
let periods = [];
let lines = [];
let filters = { from: weekStart(today()), to: today() };

const employee = id => employees.find(e => e.id === id);
const employeeLabel = e => e ? `${e.full_name} (#${e.employee_number})` : "Employee";

async function loadPayrollData() {
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  entries = await safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  periods = await safeSelect("payroll_periods", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  lines = await safeSelect("payroll_lines", "*").catch(() => []);
}

export async function renderPayroll() {
  const content = $("content");
  if (!isManager()) {
    content.innerHTML = showError("Manager access required.");
    return;
  }
  content.innerHTML = '<div class="card">Loading payroll...</div>';
  try {
    await loadPayrollData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Payroll</h2>
          <div class="toolbar">
            <input id="payrollFrom" class="input" type="date" value="${esc(filters.from)}">
            <input id="payrollTo" class="input" type="date" value="${esc(filters.to)}">
            <button class="btn" id="calculatePayrollBtn">Calculate Period</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Initial payroll uses clocked-out time entries only. Penalty rates and exports can be added after time clock testing.</div>
        <div id="payrollView"></div>
      </div>
    `;
    $("payrollFrom").onchange = e => { filters.from = e.target.value; renderPayrollView(); };
    $("payrollTo").onchange = e => { filters.to = e.target.value; renderPayrollView(); };
    $("calculatePayrollBtn").onclick = calculatePayroll;
    renderPayrollView();
  } catch (err) {
    content.innerHTML = showError("Could not load Payroll. " + err.message);
  }
}

function renderPayrollView() {
  const rows = payrollRows();
  const totalHours = rows.reduce((s, r) => s + r.hours, 0);
  const totalPay = rows.reduce((s, r) => s + r.pay, 0);
  $("payrollView").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Employees</div><div><b>${rows.length}</b></div></div>
      <div class="card"><div class="stat-title">Hours</div><div><b>${totalHours.toFixed(2)}</b></div></div>
      <div class="card"><div class="stat-title">Gross Pay</div><div><b>${money(totalPay)}</b></div></div>
      <div class="card"><div class="stat-title">Saved Periods</div><div><b>${periods.length}</b></div></div>
    </div>
    <table>
      <thead><tr><th>Employee</th><th>Rate</th><th>Paid Time</th><th>Gross Pay</th><th>Entries</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(employeeLabel(r.employee))}</td><td>${money(r.rate)}</td><td>${r.minutes} min (${r.hours.toFixed(2)}h)</td><td>${money(r.pay)}</td><td>${r.entries.length}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No clocked-out time entries in this period.</td></tr>'}</tbody>
    </table>
    <div style="margin-top:18px">
      <h3 style="margin:0 0 10px">Recent Payroll Periods</h3>
      <table><thead><tr><th>Period</th><th>Hours</th><th>Gross Pay</th><th>Status</th></tr></thead><tbody>
        ${periods.slice(0, 8).map(p => `<tr><td>${esc(p.start_date)} to ${esc(p.end_date)}</td><td>${Number(p.total_hours || 0).toFixed(2)}</td><td>${money(p.total_gross_pay)}</td><td><span class="badge gold">${esc(p.status)}</span></td></tr>`).join("") || '<tr><td colspan="4" class="muted">No payroll periods saved.</td></tr>'}
      </tbody></table>
    </div>
  `;
}

function payrollRows() {
  const periodEntries = entries.filter(e => {
    const d = (e.clock_in_at || "").slice(0, 10);
    return e.status === "clocked_out" && d >= filters.from && d <= filters.to;
  });
  const byEmployee = new Map();
  for (const entry of periodEntries) {
    const emp = employee(entry.employee_id);
    if (!emp) continue;
    const row = byEmployee.get(emp.id) || { employee: emp, rate: Number(emp.hourly_rate || 0), minutes: 0, hours: 0, pay: 0, entries: [] };
    const paidMinutes = exactPaidMinutes(entry);
    const hours = paidMinutes / 60;
    row.minutes += paidMinutes;
    row.hours += hours;
    row.pay += paidMinutes * (row.rate / 60);
    row.entries.push(entry);
    byEmployee.set(emp.id, row);
  }
  return [...byEmployee.values()].sort((a, b) => String(a.employee.employee_number).localeCompare(String(b.employee.employee_number)));
}

async function calculatePayroll() {
  const rows = payrollRows();
  if (!rows.length) return toast("No clocked-out time entries to calculate.", "error");
  try {
    const totalHours = rows.reduce((s, r) => s + r.hours, 0);
    const totalPay = rows.reduce((s, r) => s + r.pay, 0);
    const period = await insertRow("payroll_periods", {
      branch_id: state.currentBranchId,
      start_date: filters.from,
      end_date: filters.to,
      status: "calculated",
      total_hours: Number(totalHours.toFixed(2)),
      total_gross_pay: Number(totalPay.toFixed(2)),
      created_by: state.user.id,
      updated_at: new Date().toISOString(),
    });
    const payload = rows.map(r => ({
      payroll_period_id: period.id,
      employee_id: r.employee.id,
      normal_hours: Number(r.hours.toFixed(2)),
      total_paid_hours: Number(r.hours.toFixed(2)),
      hourly_rate: r.rate,
      gross_pay: Number(r.pay.toFixed(2)),
      final_gross_pay: Number(r.pay.toFixed(2)),
    }));
    const { error } = await state.db.from("payroll_lines").insert(payload);
    if (error) throw error;
    toast("Payroll period calculated.", "ok");
    renderPayroll();
  } catch (err) {
    toast("Payroll calculation failed: " + err.message, "error");
  }
}

function weekStart(date) {
  const d = new Date(`${date}T00:00:00`);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

function exactPaidMinutes(entry) {
  if (entry.clock_in_at && entry.clock_out_at) {
    const total = Math.max(0, Math.round((new Date(entry.clock_out_at) - new Date(entry.clock_in_at)) / 60000));
    return Math.max(0, total - Number(entry.break_minutes || 0));
  }
  return Number(entry.paid_minutes || 0);
}
