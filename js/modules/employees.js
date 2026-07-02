import { state, isManager } from "../state.js";
import { $, esc, money, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";

let employees = [];
let filters = { search: "", status: "active" };

const branchName = id => (state.branches || []).find(b => b.id === id)?.name || id || "-";
const employeeLabel = e => isManager() ? `${e.full_name} (#${e.employee_number})` : `Employee #${e.employee_number}`;

async function loadEmployees() {
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
}

export async function renderEmployees() {
  const content = $("content");
  if (!isManager()) {
    content.innerHTML = showError("Manager access required.");
    return;
  }
  content.innerHTML = '<div class="card">Loading employees...</div>';
  try {
    await loadEmployees();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Employees</h2>
          <div class="toolbar">
            <input id="employeeSearch" class="input" placeholder="Search employee...">
            <select id="employeeStatusFilter">
              <option value="active">Active</option>
              <option value="all">All</option>
              <option value="inactive">Inactive</option>
            </select>
            <button class="btn" id="addEmployeeBtn">+ Employee</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Staff-facing pages use employee numbers. Names are visible to managers only.</div>
        <div id="employeesTable"></div>
      </div>
    `;
    $("employeeSearch").value = filters.search;
    $("employeeStatusFilter").value = filters.status;
    $("employeeSearch").oninput = e => { filters.search = e.target.value; renderEmployeesTable(); };
    $("employeeStatusFilter").onchange = e => { filters.status = e.target.value; renderEmployeesTable(); };
    $("addEmployeeBtn").onclick = () => openEmployeeModal();
    renderEmployeesTable();
  } catch (err) {
    content.innerHTML = showError("Could not load Employees. " + err.message);
  }
}

function renderEmployeesTable() {
  const q = filters.search.trim().toLowerCase();
  const rows = employees
    .filter(e => filters.status === "all" || (filters.status === "active" ? e.active !== false : e.active === false))
    .filter(e => !q || JSON.stringify(e).toLowerCase().includes(q));
  $("employeesTable").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Active</div><div><b>${employees.filter(e => e.active !== false).length}</b></div></div>
      <div class="card"><div class="stat-title">Inactive</div><div><b>${employees.filter(e => e.active === false).length}</b></div></div>
      <div class="card"><div class="stat-title">Average Rate</div><div><b>${money(avgRate())}</b></div></div>
      <div class="card"><div class="stat-title">Branches</div><div><b>${new Set(employees.map(e => e.branch_id)).size}</b></div></div>
    </div>
    <table>
      <thead><tr><th>Employee</th><th>Branch</th><th>Employment</th><th>Rate</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(e => `<tr>
          <td><b>${esc(employeeLabel(e))}</b><div class="muted">${esc(e.email || e.phone || "")}</div></td>
          <td>${esc(branchName(e.branch_id))}</td>
          <td>${esc(e.employment_type || "")}</td>
          <td>${money(e.hourly_rate)}</td>
          <td><span class="badge ${e.active === false ? "red" : "green"}">${e.active === false ? "Inactive" : "Active"}</span></td>
          <td><button class="btn secondary small edit-employee" data-id="${esc(e.id)}">Edit</button></td>
        </tr>`).join("") || '<tr><td colspan="6" class="muted">No employees yet.</td></tr>'}
      </tbody>
    </table>
  `;
  document.querySelectorAll(".edit-employee").forEach(btn => btn.onclick = () => openEmployeeModal(employees.find(e => e.id === btn.dataset.id)));
}

function avgRate() {
  const rows = employees.filter(e => e.active !== false);
  if (!rows.length) return 0;
  return rows.reduce((sum, e) => sum + Number(e.hourly_rate || 0), 0) / rows.length;
}

function branchOptions(selected) {
  return (state.branches || []).map(b => `<option value="${esc(b.id)}" ${b.id === selected ? "selected" : ""}>${esc(b.name || b.id)}</option>`).join("");
}

function openEmployeeModal(employee = null) {
  openModal(`
    <div class="modal-head"><h3>${employee ? "Edit Employee" : "Add Employee"}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="employeeForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Employee Number</label><input name="employee_number" class="input" value="${esc(employee?.employee_number || "")}" required></div>
          <div><label>Full Name</label><input name="full_name" class="input" value="${esc(employee?.full_name || "")}" required></div>
          <div><label>Branch</label><select name="branch_id" required>${branchOptions(employee?.branch_id || state.currentBranchId)}</select></div>
          <div><label>Hourly Rate</label><input name="hourly_rate" type="number" step="0.01" class="input" value="${esc(employee?.hourly_rate ?? 0)}"></div>
          <div><label>Employment Type</label><select name="employment_type"><option ${employee?.employment_type === "casual" ? "selected" : ""}>casual</option><option ${employee?.employment_type === "part_time" ? "selected" : ""}>part_time</option><option ${employee?.employment_type === "full_time" ? "selected" : ""}>full_time</option></select></div>
          <div><label>Status</label><select name="active"><option value="true" ${employee?.active !== false ? "selected" : ""}>Active</option><option value="false" ${employee?.active === false ? "selected" : ""}>Inactive</option></select></div>
          <div><label>Phone</label><input name="phone" class="input" value="${esc(employee?.phone || "")}"></div>
          <div><label>Email</label><input name="email" type="email" class="input" value="${esc(employee?.email || "")}"></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2">${esc(employee?.notes || "")}</textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div>
    </form>
  `);
  $("employeeForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      employee_number: String(fd.get("employee_number") || "").trim(),
      full_name: String(fd.get("full_name") || "").trim(),
      branch_id: fd.get("branch_id"),
      hourly_rate: Number(fd.get("hourly_rate") || 0),
      employment_type: fd.get("employment_type"),
      active: fd.get("active") === "true",
      phone: fd.get("phone") || null,
      email: fd.get("email") || null,
      notes: fd.get("notes") || null,
      updated_at: new Date().toISOString(),
    };
    try {
      if (employee) await updateRow("employees", employee.id, payload);
      else await insertRow("employees", { ...payload, created_by: state.user.id });
      toast("Employee saved.", "ok");
      closeModal();
      renderEmployees();
    } catch (err) {
      toast("Employee save failed: " + err.message, "error");
    }
  };
}
