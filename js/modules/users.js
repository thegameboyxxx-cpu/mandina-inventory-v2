import { CONFIG } from "../config.js";
import { state, isManager } from "../state.js";
import { $, esc, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";
import { staffEmail } from "../auth.js";

let profiles = [];
let employees = [];
let invites = [];
let filters = { search: "", status: "active" };

const employee = id => employees.find(e => e.id === id);
const employeeByNumber = number => employees.find(e => String(e.employee_number).trim() === String(number).trim());
const employeeLabel = e => e ? `${e.full_name} (#${e.employee_number})` : "-";
const branchName = id => (state.branches || []).find(b => b.id === id)?.name || id || "-";

async function loadUsersData() {
  profiles = await safeSelect("profiles", "*", { order: "full_name" }).catch(() => []);
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  invites = await safeSelect("user_invites", "*", { order: "created_at", ascending: false }).catch(() => []);
}

export async function renderUsers() {
  const content = $("content");
  if (!isManager()) {
    content.innerHTML = showError("Manager access required.");
    return;
  }
  content.innerHTML = '<div class="card">Loading users...</div>';
  try {
    await loadUsersData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Users</h2>
          <div class="toolbar">
            <input id="userSearch" class="input" placeholder="Search user...">
            <select id="userStatusFilter"><option value="active">Active</option><option value="all">All</option><option value="inactive">Inactive</option></select>
            <button class="btn" id="employeeLoginBtn">+ Employee Login</button>
            <button class="btn secondary" id="googleManagerBtn">+ Google Manager</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Managers log in with Google. Staff log in with employee number and password.</div>
        <div id="usersTable"></div>
      </div>
    `;
    $("userSearch").value = filters.search;
    $("userStatusFilter").value = filters.status;
    $("userSearch").oninput = e => { filters.search = e.target.value; renderUsersTable(); };
    $("userStatusFilter").onchange = e => { filters.status = e.target.value; renderUsersTable(); };
    $("employeeLoginBtn").onclick = () => openEmployeeLoginModal();
    $("googleManagerBtn").onclick = () => openGoogleManagerModal();
    renderUsersTable();
  } catch (err) {
    content.innerHTML = showError("Could not load Users. " + err.message);
  }
}

function renderUsersTable() {
  const q = filters.search.trim().toLowerCase();
  const rows = profiles
    .filter(p => filters.status === "all" || (filters.status === "active" ? p.active !== false : p.active === false))
    .filter(p => !q || JSON.stringify({ ...p, employee: employeeLabel(employee(p.employee_id)) }).toLowerCase().includes(q));
  $("usersTable").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Active Users</div><div><b>${profiles.filter(p => p.active !== false).length}</b></div></div>
      <div class="card"><div class="stat-title">Staff Logins</div><div><b>${profiles.filter(p => p.login_type === "employee_number").length}</b></div></div>
      <div class="card"><div class="stat-title">Google Users</div><div><b>${profiles.filter(p => p.login_type === "google" || !p.login_type).length}</b></div></div>
      <div class="card"><div class="stat-title">Manager Invites</div><div><b>${invites.filter(i => i.active !== false).length}</b></div></div>
    </div>
    <table>
      <thead><tr><th>User</th><th>Login</th><th>Role</th><th>Employee</th><th>Branch</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(p => `<tr>
          <td><b>${esc(p.full_name || p.email || p.employee_number || "User")}</b><div class="muted">${esc(p.email || "")}</div></td>
          <td>${esc(loginLabel(p))}</td>
          <td><span class="badge ${p.role === "manager" ? "blue" : "gold"}">${esc(p.role || "staff")}</span></td>
          <td>${esc(employeeLabel(employee(p.employee_id)))}</td>
          <td>${esc(branchName(p.branch_id || employee(p.employee_id)?.branch_id || ""))}</td>
          <td><span class="badge ${p.active === false ? "red" : "green"}">${p.active === false ? "Inactive" : "Active"}</span></td>
          <td><button class="btn secondary small edit-user" data-id="${esc(p.id)}">Edit</button></td>
        </tr>`).join("") || '<tr><td colspan="7" class="muted">No users yet.</td></tr>'}
      </tbody>
    </table>
    ${renderInvites()}
  `;
  document.querySelectorAll(".edit-user").forEach(btn => btn.onclick = () => openUserEditModal(profiles.find(p => p.id === btn.dataset.id)));
}

function renderInvites() {
  const rows = invites.filter(i => i.active !== false);
  if (!rows.length) return "";
  return `
    <div style="margin-top:18px">
      <h3 style="margin:0 0 10px">Google Manager Invites</h3>
      <table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Branch</th><th>Status</th></tr></thead><tbody>
        ${rows.map(i => `<tr><td>${esc(i.email)}</td><td>${esc(i.full_name || "")}</td><td>${esc(i.role || "manager")}</td><td>${esc(branchName(i.branch_id))}</td><td><span class="badge green">Active</span></td></tr>`).join("")}
      </tbody></table>
    </div>
  `;
}

function loginLabel(profile) {
  if (profile.login_type === "employee_number") return `Employee #${profile.employee_number || employee(profile.employee_id)?.employee_number || ""}`;
  return "Google";
}

function employeeOptions(selected = "") {
  const activeEmployees = employees.filter(e => e.active !== false || e.id === selected);
  return '<option value="">-- Select employee --</option>' + activeEmployees.map(e => `<option value="${esc(e.id)}" ${e.id === selected ? "selected" : ""}>${esc(employeeLabel(e))}</option>`).join("");
}

function branchOptions(selected = "") {
  return (state.branches || []).map(b => `<option value="${esc(b.id)}" ${b.id === selected ? "selected" : ""}>${esc(b.name || b.id)}</option>`).join("");
}

function openEmployeeLoginModal() {
  openModal(`
    <div class="modal-head"><h3>Create Employee Login</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="employeeLoginForm">
      <div class="modal-body">
        <div class="form-grid">
          <div class="full"><label>Employee</label><select name="employee_id" id="loginEmployeeId" required>${employeeOptions()}</select></div>
          <div><label>Employee Number</label><input id="loginEmployeeNumber" class="input" disabled></div>
          <div><label>Branch</label><input id="loginEmployeeBranch" class="input" disabled></div>
          <div><label>Password</label><input name="password" type="password" class="input" required minlength="6"></div>
          <div><label>Confirm Password</label><input name="confirm_password" type="password" class="input" required minlength="6"></div>
        </div>
        <div class="muted" style="margin-top:12px">The employee will log in using the employee number shown here. The internal email is hidden from staff.</div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Create Login</button></div>
    </form>
  `);
  const sync = () => {
    const e = employee($("loginEmployeeId").value);
    $("loginEmployeeNumber").value = e?.employee_number || "";
    $("loginEmployeeBranch").value = branchName(e?.branch_id || "");
  };
  $("loginEmployeeId").onchange = sync;
  sync();
  $("employeeLoginForm").onsubmit = async event => {
    event.preventDefault();
    const fd = new FormData(event.target);
    const e = employee(fd.get("employee_id"));
    if (!e) return toast("Select an employee.", "error");
    const password = String(fd.get("password") || "");
    if (password !== String(fd.get("confirm_password") || "")) return toast("Passwords do not match.", "error");
    await createEmployeeAuthUser(e, password);
  };
}

async function createEmployeeAuthUser(employeeRow, password) {
  const email = staffEmail(employeeRow.employee_number);
  const temp = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `mandina-temp-${Date.now()}`,
    },
  });
  try {
    const { data, error } = await temp.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: employeeRow.full_name,
          employee_number: employeeRow.employee_number,
          login_type: "employee_number",
        },
      },
    });
    if (error) throw error;
    if (!data.user?.id) throw new Error("Supabase did not return a user id.");
    await upsertProfile({
      id: data.user.id,
      full_name: employeeRow.full_name,
      email,
      role: "staff",
      login_type: "employee_number",
      employee_id: employeeRow.id,
      employee_number: employeeRow.employee_number,
      branch_id: employeeRow.branch_id,
      active: true,
    });
    toast(`Login created for employee #${employeeRow.employee_number}.`, "ok");
    closeModal();
    renderUsers();
  } catch (err) {
    toast("User creation failed: " + friendlyAuthError(err), "error");
  }
}

async function upsertProfile(profile) {
  const { error } = await state.db.from("profiles").upsert({
    ...profile,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

function openGoogleManagerModal() {
  openModal(`
    <div class="modal-head"><h3>Add Google Manager</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="googleManagerForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Email</label><input name="email" type="email" class="input" required></div>
          <div><label>Full Name</label><input name="full_name" class="input"></div>
          <div><label>Branch</label><select name="branch_id">${branchOptions(state.currentBranchId)}</select></div>
          <div><label>Role</label><select name="role"><option value="manager">Manager</option><option value="staff">Staff</option></select></div>
        </div>
        <div class="muted" style="margin-top:12px">After this, the manager can use Manager Login with Google using this email.</div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save Invite</button></div>
    </form>
  `);
  $("googleManagerForm").onsubmit = async event => {
    event.preventDefault();
    const fd = new FormData(event.target);
    try {
      await insertRow("user_invites", {
        email: String(fd.get("email") || "").trim().toLowerCase(),
        full_name: fd.get("full_name") || null,
        role: fd.get("role") || "manager",
        login_type: "google",
        branch_id: fd.get("branch_id") || null,
        active: true,
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      toast("Google manager invite saved.", "ok");
      closeModal();
      renderUsers();
    } catch (err) {
      toast("Invite save failed: " + err.message, "error");
    }
  };
}

function openUserEditModal(profile) {
  if (!profile) return;
  openModal(`
    <div class="modal-head"><h3>Edit User</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="editUserForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Name</label><input name="full_name" class="input" value="${esc(profile.full_name || "")}"></div>
          <div><label>Role</label><select name="role"><option value="staff" ${profile.role !== "manager" ? "selected" : ""}>Staff</option><option value="manager" ${profile.role === "manager" ? "selected" : ""}>Manager</option></select></div>
          <div><label>Branch</label><select name="branch_id">${branchOptions(profile.branch_id || employee(profile.employee_id)?.branch_id || state.currentBranchId)}</select></div>
          <div><label>Status</label><select name="active"><option value="true" ${profile.active !== false ? "selected" : ""}>Active</option><option value="false" ${profile.active === false ? "selected" : ""}>Inactive</option></select></div>
          <div class="full"><label>Linked Employee</label><select name="employee_id">${employeeOptions(profile.employee_id || "")}</select></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div>
    </form>
  `);
  $("editUserForm").onsubmit = async event => {
    event.preventDefault();
    const fd = new FormData(event.target);
    const e = employee(fd.get("employee_id"));
    try {
      await updateRow("profiles", profile.id, {
        full_name: fd.get("full_name") || profile.full_name,
        role: fd.get("role") || "staff",
        branch_id: fd.get("branch_id") || e?.branch_id || null,
        employee_id: fd.get("employee_id") || null,
        employee_number: e?.employee_number || profile.employee_number || null,
        active: fd.get("active") === "true",
        updated_at: new Date().toISOString(),
      });
      toast("User saved.", "ok");
      closeModal();
      renderUsers();
    } catch (err) {
      toast("User save failed: " + err.message, "error");
    }
  };
}

function friendlyAuthError(err) {
  const text = err?.message || String(err);
  if (text.toLowerCase().includes("already")) return "This employee number already has a login.";
  if (text.toLowerCase().includes("email")) return `${text}. Check that email/password login is enabled in Supabase Auth.`;
  return text;
}
