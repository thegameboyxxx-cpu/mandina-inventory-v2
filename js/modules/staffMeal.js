import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal, businessToday, businessDayForTimestamp } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";
import { loadItems } from "./items.js";

let employees = [];
let meals = [];
let lines = [];
let menuItems = [];
let components = [];
let timeEntries = [];
let shifts = [];
let policy = null;

const employee = id => employees.find(e => e.id === id);
const menuName = m => m ? `${m.name}${m.name_ar ? " / " + m.name_ar : ""}` : "Menu Item";
const employeeDisplay = e => isManager() ? `${e?.full_name || "Employee"} (#${e?.employee_number || "-"})` : `Employee #${e?.employee_number || "-"}`;
const mealNo = m => m?.staff_meal_number || `SM-${String(m?.id || "").slice(0, 8)}`;

async function loadMealData() {
  await loadItems();
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  meals = await safeSelect("staff_meals", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  const mealIds = new Set(meals.map(m => m.id));
  lines = (await safeSelect("staff_meal_lines", "*").catch(() => [])).filter(l => mealIds.has(l.staff_meal_id));
  menuItems = await safeSelect("menu_items", "*", { order: "name" }).catch(() => []);
  components = await safeSelect("menu_item_components", "*", { order: "sort_order" }).catch(() => []);
  timeEntries = await safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  shifts = await safeSelect("shift_schedules", "*", { eq: { branch_id: state.currentBranchId }, order: "shift_date" }).catch(() => []);
  policy = (await safeSelect("staff_meal_policy", "*").catch(() => []))[0] || { max_discountable_amount: 30, discount_percentage: 50, require_active_shift: true, min_hours_required: 0 };
}

export async function renderStaffMeal() {
  const content = $("content");
  content.innerHTML = '<div class="card">Loading staff meals...</div>';
  try {
    await loadMealData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Staff Meal</h2>
          <div class="toolbar">
            ${isManager() ? `<button class="btn secondary" id="staffMealPolicyBtn">Meal Rule</button>` : ""}
            <button class="btn" id="requestStaffMealBtn">+ Staff Meal</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Staff meals use menu item mappings and deduct stock only when approved by a manager.</div>
        <div id="staffMealTable"></div>
      </div>
    `;
    if (isManager()) $("staffMealPolicyBtn").onclick = openPolicyModal;
    $("requestStaffMealBtn").onclick = openStaffMealModal;
    renderMealTable();
  } catch (err) {
    content.innerHTML = showError("Could not load Staff Meal. " + err.message);
  }
}

function renderMealTable() {
  $("staffMealTable").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Submitted</div><div><b>${meals.filter(m => m.status === "submitted").length}</b></div></div>
      <div class="card"><div class="stat-title">Approved Today</div><div><b>${meals.filter(m => m.status === "approved" && m.meal_date === businessToday()).length}</b></div></div>
      <div class="card"><div class="stat-title">Meal Cost</div><div><b>${money(meals.reduce((s, m) => s + Number(m.total_estimated_cost || 0), 0))}</b></div></div>
      <div class="card"><div class="stat-title">Meal Rule</div><div><b>${money(policy?.max_discountable_amount || 0)} @ ${Number(policy?.discount_percentage || 0)}%</b></div><div class="muted">${policy?.require_active_shift === false ? "Shift not required" : "Active shift preferred"}</div></div>
    </div>
    <table>
      <thead><tr><th>Meal</th><th>Date</th><th>Employee</th><th>Lines</th><th>Original Cost</th><th>Discount</th><th>Employee Charge</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${meals.map(m => `<tr>
          <td><b>${esc(mealNo(m))}</b></td>
          <td>${esc(m.meal_date || "")}</td>
          <td>${esc(employeeDisplay(employee(m.employee_id)))}</td>
          <td>${linesFor(m.id).length}</td>
          <td>${money(m.total_menu_value ?? m.total_estimated_cost)}</td>
          <td>${money(m.discount_amount)}</td>
          <td><b>${money(m.employee_charge ?? m.total_estimated_cost)}</b></td>
          <td><span class="badge ${m.status === "approved" ? "green" : m.status === "rejected" || m.status === "cancelled" ? "red" : "gold"}">${esc(m.status)}</span></td>
          <td>
            <button class="btn secondary small view-staff-meal" data-id="${esc(m.id)}">View</button>
            ${isManager() && m.status === "submitted" ? `<button class="btn green small approve-staff-meal" data-id="${esc(m.id)}">Approve</button><button class="btn red small reject-staff-meal" data-id="${esc(m.id)}">Reject</button>` : ""}
          </td>
        </tr>`).join("") || '<tr><td colspan="9" class="muted">No staff meals yet.</td></tr>'}
      </tbody>
    </table>
  `;
  document.querySelectorAll(".view-staff-meal").forEach(btn => btn.onclick = () => openMealDetails(meals.find(m => m.id === btn.dataset.id)));
  document.querySelectorAll(".approve-staff-meal").forEach(btn => btn.onclick = () => approveMeal(meals.find(m => m.id === btn.dataset.id)));
  document.querySelectorAll(".reject-staff-meal").forEach(btn => btn.onclick = () => rejectMeal(meals.find(m => m.id === btn.dataset.id)));
}

function linesFor(mealId) {
  return lines.filter(l => l.staff_meal_id === mealId);
}

function openStaffMealModal() {
  openModal(`
    <div class="modal-head"><h3>Staff Meal Request</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="staffMealForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Employee Number</label><input name="employee_number" class="input" inputmode="numeric" required></div>
          <div><label>Meal Date</label><input name="meal_date" type="date" class="input" value="${businessToday()}" required></div>
          <div><label>Menu Item</label><select name="menu_item_id" required>${menuItems.filter(m => m.active !== false).map(m => `<option value="${esc(m.id)}">${esc(menuName(m))}</option>`).join("")}</select></div>
          <div><label>Qty</label><input name="qty" class="input" type="number" step="0.001" value="1" required></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Submit</button></div>
    </form>
  `);
  $("staffMealForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const emp = employees.find(x => String(x.employee_number) === String(fd.get("employee_number")).trim() && x.active !== false);
    if (!emp) return toast("Employee number not found or inactive.", "error");
    if (emp.branch_id !== state.currentBranchId) return toast("Employee belongs to a different branch.", "error");
    const activeShift = timeEntries.find(t => t.employee_id === emp.id && t.status === "clocked_in");
    if (!activeShift) toast("No active shift found. Manager can still review this request.", "info");
    const menu = menuItems.find(m => m.id === fd.get("menu_item_id"));
    const amount = Number(fd.get("qty") || 1);
    const total = Number(menu?.sale_price || 0) * amount;
    const discountable = Math.min(total, Number(policy?.max_discountable_amount || 0));
    const discount = discountable * Number(policy?.discount_percentage || 0) / 100;
    const charge = total - discount;
    const shift = activeShift ? shifts.find(s => s.id === activeShift.shift_id) : null;
    const mealDate = shift?.shift_date || (activeShift ? businessDayForTimestamp(activeShift.clock_in_at || activeShift.created_at) : fd.get("meal_date"));
    try {
      const meal = await insertRow("staff_meals", {
        staff_meal_number: `SM-${Date.now().toString().slice(-8)}`,
        branch_id: state.currentBranchId,
        employee_id: emp.id,
        user_id: state.user.id,
        meal_date: mealDate,
        shift_id: activeShift?.shift_id || null,
        status: "submitted",
        total_estimated_cost: total,
        total_menu_value: total,
        discountable_amount: discountable,
        discount_amount: discount,
        full_price_remainder: Math.max(0, total - discountable),
        employee_charge: charge,
        allowance_used: true,
        notes: fd.get("notes") || null,
        requested_by: state.user.id,
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      await insertRow("staff_meal_lines", {
        staff_meal_id: meal.id,
        menu_item_id: menu.id,
        item_name: menuName(menu),
        qty: amount,
        unit_price: Number(menu?.sale_price || 0),
        estimated_cost: total,
      });
      toast("Staff meal submitted.", "ok");
      closeModal();
      renderStaffMeal();
    } catch (err) {
      toast("Staff meal save failed: " + err.message, "error");
    }
  };
}

function openPolicyModal() {
  openModal(`
    <div class="modal-head"><h3>Staff Meal Rule</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="staffMealPolicyForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Max Discountable Amount</label><input name="max_discountable_amount" type="number" step="0.01" class="input" value="${esc(policy?.max_discountable_amount ?? 30)}"></div>
          <div><label>Discount Percentage</label><input name="discount_percentage" type="number" step="0.01" class="input" value="${esc(policy?.discount_percentage ?? 50)}"></div>
          <div><label>Minimum Hours Required</label><input name="min_hours_required" type="number" step="0.01" class="input" value="${esc(policy?.min_hours_required ?? 0)}"></div>
          <div><label>Require Active Shift</label><select name="require_active_shift"><option value="true" ${policy?.require_active_shift !== false ? "selected" : ""}>Yes</option><option value="false" ${policy?.require_active_shift === false ? "selected" : ""}>No</option></select></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save Rule</button></div>
    </form>
  `);
  $("staffMealPolicyForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      max_discountable_amount: Number(fd.get("max_discountable_amount") || 0),
      discount_percentage: Number(fd.get("discount_percentage") || 0),
      min_hours_required: Number(fd.get("min_hours_required") || 0),
      require_active_shift: fd.get("require_active_shift") === "true",
      updated_at: new Date().toISOString(),
      updated_by: state.user.id,
    };
    try {
      if (policy?.id) await updateRow("staff_meal_policy", policy.id, payload);
      else await insertRow("staff_meal_policy", payload);
      toast("Staff meal rule saved.", "ok");
      closeModal();
      renderStaffMeal();
    } catch (err) {
      toast("Rule save failed: " + err.message, "error");
    }
  };
}

function openMealDetails(meal) {
  if (!meal) return;
  const mealLines = linesFor(meal.id);
  openModal(`
    <div class="modal-head"><h3>${esc(mealNo(meal))}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div><label>Employee</label><input class="input" value="${esc(employeeDisplay(employee(meal.employee_id)))}" disabled></div>
        <div><label>Status</label><input class="input" value="${esc(meal.status)}" disabled></div>
        <div class="full"><label>Notes</label><textarea class="input" rows="3" disabled>${esc(meal.notes || "")}</textarea></div>
      </div>
      <table style="margin-top:14px"><thead><tr><th>Item</th><th>Qty</th><th>Mapping</th></tr></thead><tbody>
        ${mealLines.map(l => `<tr><td>${esc(l.item_name || "")}</td><td>${qty(l.qty)}</td><td>${components.filter(c => c.menu_item_id === l.menu_item_id).length ? '<span class="badge green">Mapped</span>' : '<span class="badge red">Not mapped</span>'}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
}

async function approveMeal(meal) {
  if (!meal) return;
  try {
    for (const line of linesFor(meal.id)) {
      const comps = components.filter(c => c.menu_item_id === line.menu_item_id);
      if (!comps.length) throw new Error(`${line.item_name} has no mapping.`);
      for (const comp of comps) {
        const si = state.items.find(i => i.id === comp.item_id);
        const amount = -Math.abs(Number(comp.qty_per_portion || 0) * Number(line.qty || 0));
        const { error } = await state.db.from("stock_movements").insert({
          branch_id: state.currentBranchId,
          item_id: comp.item_id,
          movement_type: "STAFF_MEAL",
          qty_change: amount,
          qty: amount,
          quantity: amount,
          stock_unit: comp.unit || si?.stock_unit || "",
          unit: comp.unit || si?.stock_unit || "",
          reference_id: meal.id,
          reference_type: "staff_meal",
          notes: `Staff meal ${mealNo(meal)}: ${line.item_name}`,
          created_by: state.user.id,
        });
        if (error) throw error;
      }
    }
    await updateRow("staff_meals", meal.id, { status: "approved", approved_by: state.user.id, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    toast("Staff meal approved and stock deducted.", "ok");
    renderStaffMeal();
  } catch (err) {
    toast("Approve failed: " + err.message, "error");
  }
}

async function rejectMeal(meal) {
  if (!meal) return;
  await updateRow("staff_meals", meal.id, { status: "rejected", rejected_by: state.user.id, rejected_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  toast("Staff meal rejected.", "ok");
  renderStaffMeal();
}
