import { state, isManager } from "../state.js";
import { $, esc, money, showError, toast, today, dateKey, openModal, closeModal, businessDayForTimestamp, formatDateTimeMelbourne } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";

let employees = [];
let entries = [];
let shifts = [];
let periods = [];
let lines = [];
let staffMeals = [];
let staffMealLines = [];
let cashCounts = [];
let payments = [];
let employeeDeductions = [];
let filters = { from: weekStart(today()), to: today() };

const employee = id => employees.find(e => e.id === id);
const employeeLabel = e => e ? `${e.full_name} (#${e.employee_number})` : "Employee";
const DEDUCTION_TYPES = [
  ["damage", "Damage"],
  ["advance", "Advance"],
  ["manual_deduction", "Manual Deduction"],
  ["other", "Other"],
];
const deductionTypeLabel = value => DEDUCTION_TYPES.find(t => t[0] === value)?.[1] || value || "Other";
const deductionTypeOptions = selected => DEDUCTION_TYPES.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`).join("");

async function loadPayrollData() {
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  entries = await safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  shifts = await safeSelect("shift_schedules", "*", { eq: { branch_id: state.currentBranchId }, order: "shift_date" }).catch(() => []);
  periods = await safeSelect("payroll_periods", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  lines = await safeSelect("payroll_lines", "*").catch(() => []);
  staffMeals = await safeSelect("staff_meals", "*", { eq: { branch_id: state.currentBranchId }, order: "meal_date", ascending: false }).catch(() => []);
  const mealIds = new Set(staffMeals.map(m => m.id));
  staffMealLines = (await safeSelect("staff_meal_lines", "*").catch(() => [])).filter(l => mealIds.has(l.staff_meal_id));
  cashCounts = await safeSelect("cash_register_counts", "*", { eq: { branch_id: state.currentBranchId }, order: "count_date", ascending: false }).catch(() => []);
  payments = await safeSelect("payroll_payments", "*", { eq: { branch_id: state.currentBranchId }, order: "paid_at", ascending: false }).catch(() => []);
  employeeDeductions = await safeSelect("employee_deductions", "*", { eq: { branch_id: state.currentBranchId }, order: "deduction_date", ascending: false }).catch(() => []);
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
            <button class="btn secondary" id="employeeDeductionsBtn">Deductions</button>
            <button class="btn" id="calculatePayrollBtn">Calculate Period</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Payroll uses exact clocked-out minutes, deducts approved staff meals, and can record cash or other salary payments.</div>
        <div id="payrollView"></div>
      </div>
    `;
    $("payrollFrom").onchange = e => { filters.from = e.target.value; renderPayrollView(); };
    $("payrollTo").onchange = e => { filters.to = e.target.value; renderPayrollView(); };
    $("employeeDeductionsBtn").onclick = openDeductionsModal;
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
      <thead><tr><th>Employee</th><th>Rate</th><th>Paid Time</th><th>Gross</th><th>Meal Charges</th><th>Other Deductions</th><th>Net Pay</th><th>Paid</th><th>Due</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(employeeLabel(r.employee))}</td>
        <td>${money(r.rate)}</td>
        <td>${r.minutes} min (${r.hours.toFixed(2)}h)</td>
        <td>${money(r.grossPay)}</td>
        <td>${money(r.staffMealDeductions)}</td>
        <td>${money(r.otherDeductions)}</td>
        <td><b>${money(r.netPay)}</b></td>
        <td>${money(r.paid)}</td>
        <td>${money(r.due)}</td>
        <td>
          <button class="btn secondary small payroll-view" data-id="${esc(r.employee.id)}">View</button>
          ${payrollAction(r)}
        </td>
      </tr>`).join("") || '<tr><td colspan="10" class="muted">No clocked-out time entries in this period.</td></tr>'}</tbody>
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
    const d = entryBusinessDay(e);
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
  for (const emp of employees.filter(e => e.active !== false && e.branch_id === state.currentBranchId)) {
    if (byEmployee.has(emp.id)) continue;
    if (mealDeductions(emp.id).length || otherDeductions(emp.id).length || periodPayments(emp.id).length) {
      byEmployee.set(emp.id, baseRow(emp));
    }
  }
  for (const row of byEmployee.values()) {
    row.staffMealItems = mealDeductions(row.employee.id);
    row.otherDeductionItems = otherDeductions(row.employee.id);
    row.deductionItems = [...row.staffMealItems, ...row.otherDeductionItems];
    row.grossPay = cents(row.grossPay);
    row.staffMealDeductions = cents(row.staffMealItems.reduce((s, d) => s + d.amount, 0));
    row.otherDeductions = cents(row.otherDeductionItems.reduce((s, d) => s + d.amount, 0));
    row.deductions = cents(row.staffMealDeductions + row.otherDeductions);
    row.netPay = cents(row.grossPay - row.deductions);
    row.paymentItems = periodPayments(row.employee.id);
    row.paid = cents(row.paymentItems.reduce((s, p) => s + Number(p.payment_amount || 0), 0));
    row.due = cents(row.netPay - row.paid);
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
    staffMealDeductions: 0,
    otherDeductions: 0,
    netPay: 0,
    paid: 0,
    due: 0,
    entries: [],
    deductionItems: [],
    staffMealItems: [],
    otherDeductionItems: [],
    paymentItems: [],
  };
}

function payrollAction(row) {
  if (row.due < 0) return '<span class="badge red">Owes Company</span>';
  if (row.due === 0) return '<span class="badge green">Paid</span>';
  return `<button class="btn green small payroll-pay" data-id="${esc(row.employee.id)}">Pay</button>`;
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
      type: "Staff Meal Charges",
      reason: mealSummary(m),
      amount: Number(m.employee_charge ?? m.total_estimated_cost ?? 0),
      meal: m,
    }))
    .filter(d => d.amount > 0);
}

function otherDeductions(employeeId) {
  return employeeDeductions
    .filter(d => {
      const deductionDate = dateOnly(d.deduction_date || d.created_at);
      return d.employee_id === employeeId && d.status !== "voided" && deductionDate >= filters.from && deductionDate <= filters.to;
    })
    .map(d => ({
      id: d.id,
      date: dateOnly(d.deduction_date || d.created_at),
      label: deductionTypeLabel(d.deduction_type),
      type: deductionTypeLabel(d.deduction_type),
      reason: d.reason || d.notes || "-",
      amount: Number(d.amount || 0),
      deduction: d,
    }))
    .filter(d => d.amount > 0);
}

function periodPayments(employeeId) {
  return payments.filter(p =>
    p.employee_id === employeeId &&
    p.status !== "voided" &&
    paymentOverlapsFilter(p)
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
        ${row.entries.map(e => `<tr><td>${esc(entryBusinessDay(e))}</td><td>${esc(localDateTime(e.clock_in_at))}</td><td>${esc(localDateTime(e.clock_out_at))}</td><td>${Number(e.paid_minutes_exact || 0)}</td><td>${money(Number(e.paid_minutes_exact || 0) * (row.rate / 60))}</td></tr>`).join("")}
      </tbody></table>
      <h3 style="margin:18px 0 10px">Deductions</h3>
      <table><thead><tr><th>Date</th><th>Type</th><th>For</th><th>Reason</th><th>Amount</th></tr></thead><tbody>
        ${row.deductionItems.map(d => `<tr><td>${esc(d.date)}</td><td>${esc(d.type || "-")}</td><td>${esc(d.label)}</td><td>${esc(d.reason)}</td><td>${money(d.amount)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No deductions in this period.</td></tr>'}
      </tbody></table>
      <h3 style="margin:18px 0 10px">Payments</h3>
      <table><thead><tr><th>Date</th><th>Covers</th><th>Method</th><th>Reference</th><th>Amount</th><th>Notes</th><th></th></tr></thead><tbody>
        ${row.paymentItems.map(p => `<tr><td>${esc(localDateTime(p.paid_at))}</td><td>${esc(dateOnly(p.period_start))} to ${esc(dateOnly(p.period_end))}</td><td>${esc(p.payment_method)}</td><td>${esc(p.payment_reference || "-")}</td><td>${money(p.payment_amount)}</td><td>${esc(p.notes || "")}</td><td><button class="btn red small void-payroll-payment" data-id="${esc(p.id)}">Cancel</button></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No payments recorded for this period.</td></tr>'}
      </tbody></table>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
  document.querySelectorAll(".void-payroll-payment").forEach(btn => btn.onclick = () => voidPayrollPayment(payments.find(p => p.id === btn.dataset.id)));
}

function openDeductionsModal() {
  const activeEmployees = employees.filter(e => e.active !== false && e.branch_id === state.currentBranchId);
  openModal(`
    <div class="modal-head"><h3>Employee Deductions</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="employeeDeductionForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Employee</label><select name="employee_id" required>${activeEmployees.map(e => `<option value="${esc(e.id)}">${esc(employeeLabel(e))}</option>`).join("")}</select></div>
          <div><label>Date</label><input name="deduction_date" type="date" class="input" value="${esc(today())}" required></div>
          <div><label>Type</label><select name="deduction_type">${deductionTypeOptions()}</select></div>
          <div><label>Amount</label><input name="amount" type="number" step="0.01" class="input" required></div>
          <div class="full"><label>Reason</label><input name="reason" class="input" placeholder="Reason for deduction"></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
        <h3 style="margin:18px 0 10px">Recent Deductions</h3>
        <table><thead><tr><th>Date</th><th>Employee</th><th>Type</th><th>Amount</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
          ${employeeDeductions.slice(0, 20).map(d => `<tr><td>${esc(dateOnly(d.deduction_date || d.created_at))}</td><td>${esc(employeeLabel(employee(d.employee_id)))}</td><td>${esc(deductionTypeLabel(d.deduction_type))}</td><td>${money(d.amount)}</td><td>${esc(d.reason || d.notes || "")}</td><td><span class="badge ${d.status === "voided" ? "red" : "green"}">${esc(d.status || "active")}</span></td><td>${d.status === "voided" ? "" : `<button type="button" class="btn red small void-deduction" data-id="${esc(d.id)}">Cancel</button>`}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No manual deductions yet.</td></tr>'}
        </tbody></table>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Add Deduction</button></div>
    </form>
  `);
  document.querySelectorAll(".void-deduction").forEach(btn => btn.onclick = () => voidEmployeeDeduction(employeeDeductions.find(d => d.id === btn.dataset.id)));
  $("employeeDeductionForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = Number(fd.get("amount") || 0);
    if (amount <= 0) return toast("Deduction amount must be more than zero.", "error");
    try {
      await insertRow("employee_deductions", {
        branch_id: state.currentBranchId,
        employee_id: fd.get("employee_id"),
        deduction_date: fd.get("deduction_date"),
        deduction_type: fd.get("deduction_type"),
        amount,
        reason: fd.get("reason") || null,
        notes: fd.get("notes") || null,
        status: "active",
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      toast("Employee deduction added.", "ok");
      closeModal();
      renderPayroll();
    } catch (err) {
      toast("Deduction save failed: " + err.message, "error");
    }
  };
}

async function voidEmployeeDeduction(deduction) {
  if (!deduction || deduction.status === "voided") return;
  if (!confirm("Cancel this deduction? It will be removed from payroll calculations but kept in history.")) return;
  try {
    await updateRow("employee_deductions", deduction.id, {
      status: "voided",
      voided_by: state.user.id,
      voided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    toast("Deduction cancelled.", "ok");
    closeModal();
    renderPayroll();
  } catch (err) {
    toast("Deduction cancel failed: " + err.message, "error");
  }
}

async function voidPayrollPayment(payment) {
  if (!payment || payment.status === "voided") return;
  if (!confirm("Cancel this payroll payment record? Cash balance and due amount will recalculate.")) return;
  try {
    await updateRow("payroll_payments", payment.id, {
      status: "voided",
      voided_by: state.user.id,
      voided_at: new Date().toISOString(),
      notes: [payment.notes, `Voided ${new Date().toISOString()} by ${state.user.id}`].filter(Boolean).join("\n"),
    });
    toast("Payment record cancelled.", "ok");
    closeModal();
    renderPayroll();
  } catch (err) {
    toast("Payment cancel failed: " + err.message, "error");
  }
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
  return formatDateTimeMelbourne(value);
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function paymentOverlapsFilter(payment) {
  const start = dateOnly(payment.period_start);
  const end = dateOnly(payment.period_end);
  return start <= filters.to && end >= filters.from;
}

function entryBusinessDay(entry) {
  const shift = shifts.find(s => s.id === entry.shift_id);
  return shift?.shift_date || businessDayForTimestamp(entry.clock_in_at || entry.created_at);
}
