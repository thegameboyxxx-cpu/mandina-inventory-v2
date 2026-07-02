import { state, isManager } from "../state.js";
import { $, esc, money, showError, toast, today, dateKey, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow } from "../services/db.js";

let employees = [];
let entries = [];
let periods = [];
let lines = [];
let staffMeals = [];
let staffMealLines = [];
let cashCounts = [];
let payments = [];
let filters = { from: weekStart(today()), to: today() };

const employee = id => employees.find(e => e.id === id);
const employeeLabel = e => e ? `${e.full_name} (#${e.employee_number})` : "Employee";

async function loadPayrollData() {
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  entries = await safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  periods = await safeSelect("payroll_periods", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  lines = await safeSelect("payroll_lines", "*").catch(() => []);
  staffMeals = await safeSelect("staff_meals", "*", { eq: { branch_id: state.currentBranchId }, order: "meal_date", ascending: false }).catch(() => []);
  const mealIds = new Set(staffMeals.map(m => m.id));
  staffMealLines = (await safeSelect("staff_meal_lines", "*").catch(() => [])).filter(l => mealIds.has(l.staff_meal_id));
  cashCounts = await safeSelect("cash_register_counts", "*", { eq: { branch_id: state.currentBranchId }, order: "count_date", ascending: false }).catch(() => []);
  payments = await safeSelect("payroll_payments", "*", { eq: { branch_id: state.currentBranchId }, order: "paid_at", ascending: false }).catch(() => []);
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
        <div class="muted" style="margin-bottom:12px">Payroll uses exact clocked-out minutes, deducts approved staff meals, and can record cash or other salary payments.</div>
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
  const totalGross = rows.reduce((s, r) => s + r.grossPay, 0);
  const totalDeductions = rows.reduce((s, r) => s + r.deductions, 0);
  const totalNet = rows.reduce((s, r) => s + r.netPay, 0);
  const cash = cashBalance();
  $("payrollView").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Employees</div><div><b>${rows.length}</b></div></div>
      <div class="card"><div class="stat-title">Hours</div><div><b>${totalHours.toFixed(2)}</b></div></div>
      <div class="card"><div class="stat-title">Gross Pay</div><div><b>${money(totalGross)}</b></div></div>
      <div class="card"><div class="stat-title">Deductions</div><div><b>${money(totalDeductions)}</b></div></div>
      <div class="card"><div class="stat-title">Net Pay</div><div><b>${money(totalNet)}</b></div></div>
      <div class="card"><div class="stat-title">Cash Balance</div><div><b>${money(cash)}</b></div></div>
    </div>
    <table>
      <thead><tr><th>Employee</th><th>Rate</th><th>Paid Time</th><th>Gross</th><th>Deductions</th><th>Net Pay</th><th>Paid</th><th>Due</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(employeeLabel(r.employee))}</td>
        <td>${money(r.rate)}</td>
        <td>${r.minutes} min (${r.hours.toFixed(2)}h)</td>
        <td>${money(r.grossPay)}</td>
        <td>${money(r.deductions)}<div class="muted">Staff meals</div></td>
        <td><b>${money(r.netPay)}</b></td>
        <td>${money(r.paid)}</td>
        <td>${money(r.due)}</td>
        <td>
          <button class="btn secondary small payroll-view" data-id="${esc(r.employee.id)}">View</button>
          ${r.due <= 0 ? '<span class="badge green">Paid</span>' : `<button class="btn green small payroll-pay" data-id="${esc(r.employee.id)}">Pay</button>`}
        </td>
      </tr>`).join("") || '<tr><td colspan="9" class="muted">No clocked-out time entries in this period.</td></tr>'}</tbody>
    </table>
    <div style="margin-top:18px">
      <h3 style="margin:0 0 10px">Recent Payroll Periods</h3>
      <table><thead><tr><th>Period</th><th>Hours</th><th>Gross Pay</th><th>Status</th></tr></thead><tbody>
        ${periods.slice(0, 8).map(p => `<tr><td>${esc(p.start_date)} to ${esc(p.end_date)}</td><td>${Number(p.total_hours || 0).toFixed(2)}</td><td>${money(p.total_gross_pay)}</td><td><span class="badge gold">${esc(p.status)}</span></td></tr>`).join("") || '<tr><td colspan="4" class="muted">No payroll periods saved.</td></tr>'}
      </tbody></table>
    </div>
  `;
  document.querySelectorAll(".payroll-view").forEach(btn => btn.onclick = () => openPayrollDetails(rows.find(r => r.employee.id === btn.dataset.id)));
  document.querySelectorAll(".payroll-pay").forEach(btn => btn.onclick = () => openPayModal(rows.find(r => r.employee.id === btn.dataset.id)));
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
    const row = byEmployee.get(emp.id) || baseRow(emp);
    const paidMinutes = exactPaidMinutes(entry);
    const hours = paidMinutes / 60;
    row.minutes += paidMinutes;
    row.hours += hours;
    row.grossPay += paidMinutes * (row.rate / 60);
    row.entries.push({ ...entry, paid_minutes_exact: paidMinutes });
    byEmployee.set(emp.id, row);
  }
  for (const row of byEmployee.values()) {
    row.deductionItems = mealDeductions(row.employee.id);
    row.grossPay = cents(row.grossPay);
    row.deductions = cents(row.deductionItems.reduce((s, d) => s + d.amount, 0));
    row.netPay = cents(Math.max(0, row.grossPay - row.deductions));
    row.paymentItems = periodPayments(row.employee.id);
    row.paid = cents(row.paymentItems.reduce((s, p) => s + Number(p.payment_amount || 0), 0));
    row.due = cents(Math.max(0, row.netPay - row.paid));
  }
  return [...byEmployee.values()].sort((a, b) => String(a.employee.employee_number).localeCompare(String(b.employee.employee_number)));
}

function baseRow(emp) {
  return {
    employee: emp,
    rate: Number(emp.hourly_rate || 0),
    minutes: 0,
    hours: 0,
    grossPay: 0,
    deductions: 0,
    netPay: 0,
    paid: 0,
    due: 0,
    entries: [],
    deductionItems: [],
    paymentItems: [],
  };
}

function mealDeductions(employeeId) {
  return staffMeals
    .filter(m => {
      const mealDate = dateOnly(m.meal_date);
      return m.employee_id === employeeId && m.status === "approved" && mealDate >= filters.from && mealDate <= filters.to;
    })
    .map(m => ({
      id: m.id,
      date: dateOnly(m.meal_date),
      label: mealNo(m),
      reason: mealSummary(m),
      amount: Number(m.employee_charge ?? m.total_estimated_cost ?? 0),
      meal: m,
    }))
    .filter(d => d.amount > 0);
}

function periodPayments(employeeId) {
  return payments.filter(p =>
    p.employee_id === employeeId &&
    p.status !== "voided" &&
    dateOnly(p.period_start) === filters.from &&
    dateOnly(p.period_end) === filters.to
  );
}

async function calculatePayroll() {
  const rows = payrollRows();
  if (!rows.length) return toast("No clocked-out time entries to calculate.", "error");
  try {
    const totalHours = rows.reduce((s, r) => s + r.hours, 0);
    const totalGross = rows.reduce((s, r) => s + r.grossPay, 0);
    const totalDeductions = rows.reduce((s, r) => s + r.deductions, 0);
    const period = await insertRow("payroll_periods", {
      branch_id: state.currentBranchId,
      start_date: filters.from,
      end_date: filters.to,
      status: "calculated",
      total_hours: Number(totalHours.toFixed(2)),
      total_gross_pay: Number(totalGross.toFixed(2)),
      notes: totalDeductions ? `Staff meal deductions: ${money(totalDeductions)}` : null,
      created_by: state.user.id,
      updated_at: new Date().toISOString(),
    });
    const payload = rows.map(r => ({
      payroll_period_id: period.id,
      employee_id: r.employee.id,
      normal_hours: Number(r.hours.toFixed(2)),
      total_paid_hours: Number(r.hours.toFixed(2)),
      hourly_rate: r.rate,
      gross_pay: Number(r.grossPay.toFixed(2)),
      deductions: Number(r.deductions.toFixed(2)),
      final_gross_pay: Number(r.netPay.toFixed(2)),
      notes: r.deductionItems.map(d => `${d.label}: ${money(d.amount)}`).join("; ") || null,
    }));
    const { error } = await state.db.from("payroll_lines").insert(payload);
    if (error) throw error;
    toast("Payroll period calculated.", "ok");
    renderPayroll();
  } catch (err) {
    toast("Payroll calculation failed: " + err.message, "error");
  }
}

function openPayrollDetails(row) {
  if (!row) return;
  openModal(`
    <div class="modal-head"><h3>${esc(employeeLabel(row.employee))}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Gross</div><div><b>${money(row.grossPay)}</b></div></div>
        <div class="card"><div class="stat-title">Deductions</div><div><b>${money(row.deductions)}</b></div></div>
        <div class="card"><div class="stat-title">Net Pay</div><div><b>${money(row.netPay)}</b></div></div>
        <div class="card"><div class="stat-title">Due</div><div><b>${money(row.due)}</b></div></div>
      </div>
      <h3 style="margin:0 0 10px">Clock Entries</h3>
      <table><thead><tr><th>Date</th><th>Clock In</th><th>Clock Out</th><th>Minutes</th><th>Pay</th></tr></thead><tbody>
        ${row.entries.map(e => `<tr><td>${esc((e.clock_in_at || "").slice(0, 10))}</td><td>${esc(localDateTime(e.clock_in_at))}</td><td>${esc(localDateTime(e.clock_out_at))}</td><td>${Number(e.paid_minutes_exact || 0)}</td><td>${money(Number(e.paid_minutes_exact || 0) * (row.rate / 60))}</td></tr>`).join("")}
      </tbody></table>
      <h3 style="margin:18px 0 10px">Deductions</h3>
      <table><thead><tr><th>Date</th><th>For</th><th>Reason</th><th>Amount</th></tr></thead><tbody>
        ${row.deductionItems.map(d => `<tr><td>${esc(d.date)}</td><td>${esc(d.label)}</td><td>${esc(d.reason)}</td><td>${money(d.amount)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No deductions in this period.</td></tr>'}
      </tbody></table>
      <h3 style="margin:18px 0 10px">Payments</h3>
      <table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th><th>Notes</th></tr></thead><tbody>
        ${row.paymentItems.map(p => `<tr><td>${esc(localDateTime(p.paid_at))}</td><td>${esc(p.payment_method)}</td><td>${esc(p.payment_reference || "-")}</td><td>${money(p.payment_amount)}</td><td>${esc(p.notes || "")}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No payments recorded for this period.</td></tr>'}
      </tbody></table>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
}

function openPayModal(row) {
  if (!row) return;
  const cash = cashBalance();
  openModal(`
    <div class="modal-head"><h3>Pay ${esc(employeeLabel(row.employee))}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="payrollPayForm">
      <div class="modal-body">
        <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
          <div class="card"><div class="stat-title">Net Pay</div><div><b>${money(row.netPay)}</b></div></div>
          <div class="card"><div class="stat-title">Already Paid</div><div><b>${money(row.paid)}</b></div></div>
          <div class="card"><div class="stat-title">Due</div><div><b>${money(row.due)}</b></div></div>
          <div class="card"><div class="stat-title">Cash Available</div><div><b>${money(cash)}</b></div></div>
        </div>
        <div class="form-grid">
          <div><label>Payment Method</label><select name="payment_method" id="payrollPaymentMethod"><option value="cash">Cash</option><option value="bank">Bank Transfer</option><option value="card">Card</option><option value="other">Other</option></select></div>
          <div><label>Amount</label><input name="payment_amount" id="payrollPaymentAmount" type="number" step="0.01" class="input" value="${esc(row.due.toFixed(2))}" required></div>
          <div><label>Cash Before</label><input id="payrollCashBefore" class="input" value="${esc(money(cash))}" disabled></div>
          <div><label>Cash After</label><input id="payrollCashAfter" class="input" disabled></div>
          <div class="full"><label>Reference / How was it paid?</label><input name="payment_reference" class="input" placeholder="Cash, bank reference, owner transfer, other"></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn green">Record Payment</button></div>
    </form>
  `);
  const syncCash = () => {
    const amount = Number($("payrollPaymentAmount").value || 0);
    const isCash = $("payrollPaymentMethod").value === "cash";
    $("payrollCashBefore").value = isCash ? money(cash) : "-";
    $("payrollCashAfter").value = isCash ? money(cash - amount) : "-";
  };
  $("payrollPaymentMethod").onchange = syncCash;
  $("payrollPaymentAmount").oninput = syncCash;
  syncCash();
  $("payrollPayForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = Number(Number(fd.get("payment_amount") || 0).toFixed(2));
    const method = fd.get("payment_method");
    if (amount <= 0) return toast("Payment amount must be more than zero.", "error");
    const due = cents(row.due);
    const availableCash = cents(cash);
    if (amount > due) return toast(`Payment amount cannot be more than the amount due (${money(due)}).`, "error");
    if (method === "cash" && amount > availableCash) return toast("Not enough cash balance for this payment.", "error");
    try {
      await insertRow("payroll_payments", {
        branch_id: state.currentBranchId,
        employee_id: row.employee.id,
        period_start: filters.from,
        period_end: filters.to,
        gross_pay: Number(row.grossPay.toFixed(2)),
        deductions: Number(row.deductions.toFixed(2)),
        net_pay: Number(row.netPay.toFixed(2)),
        payment_amount: amount,
        payment_method: method,
        payment_reference: fd.get("payment_reference") || null,
        cash_balance_before: method === "cash" ? Number(cash.toFixed(2)) : null,
        cash_balance_after: method === "cash" ? Number((cash - amount).toFixed(2)) : null,
        notes: fd.get("notes") || null,
        status: "paid",
        paid_by: state.user.id,
      });
      toast("Payroll payment recorded.", "ok");
      closeModal();
      renderPayroll();
    } catch (err) {
      toast("Payment failed: " + err.message, "error");
    }
  };
}

function cashBalance() {
  const counted = cashCounts
    .filter(c => c.status !== "voided")
    .reduce((s, c) => s + Number(c.actual_cash || 0), 0);
  const cashPaid = payments
    .filter(p => p.status !== "voided" && p.payment_method === "cash")
    .reduce((s, p) => s + Number(p.payment_amount || 0), 0);
  return cents(counted - cashPaid);
}

function cents(value) {
  return Number(Number(value || 0).toFixed(2));
}

function mealSummary(meal) {
  const mealLines = staffMealLines.filter(l => l.staff_meal_id === meal.id);
  return mealLines.map(l => `${l.item_name || "Staff meal"} x ${Number(l.qty || 1)}`).join(", ") || "Approved staff meal";
}

function mealNo(m) {
  return m?.staff_meal_number || `SM-${String(m?.id || "").slice(0, 8)}`;
}

function weekStart(date) {
  const d = new Date(`${date}T00:00:00`);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return dateKey(d);
}

function exactPaidMinutes(entry) {
  if (entry.clock_in_at && entry.clock_out_at) {
    const total = Math.max(0, Math.round((new Date(entry.clock_out_at) - new Date(entry.clock_in_at)) / 60000));
    return Math.max(0, total - Number(entry.break_minutes || 0));
  }
  return Number(entry.paid_minutes || 0);
}

function localDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-AU", { dateStyle: "short", timeStyle: "short" });
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}
