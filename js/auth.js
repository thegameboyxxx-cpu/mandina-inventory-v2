import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { $, toast } from "./utils.js";
import { safeSelect } from "./services/db.js";

export const staffEmail = employeeNumber => `${String(employeeNumber || "").trim()}@staff.mandina.com.au`;
export const staffAuthPassword = pin => `MandinaStaff-${String(pin || "").trim()}`;
const staffEmailDomains = ["@staff.mandina.com.au", "@staff.mandina.local"];

export async function initAuth() {
  const { data } = await state.db.auth.getSession();
  if (!data.session) {
    $("loginPage").classList.remove("hidden");
    return false;
  }
  state.user = data.session.user;
  await ensureProfile();
  await ensureBranches();
  await loadBranches();
  return true;
}

export async function loginGoogle() {
  showLoginError("");
  const { error } = await state.db.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: CONFIG.appUrl },
  });
  if (error) showLoginError(error.message);
}

export async function loginStaff() {
  showLoginError("");
  const employeeNumber = $("staffEmployeeNumber").value.trim();
  const password = $("staffPassword").value;
  if (!employeeNumber || !password) return showLoginError("Enter employee number and password.");
  const { error } = await state.db.auth.signInWithPassword({
    email: staffEmail(employeeNumber),
    password: staffAuthPassword(password),
  });
  if (error) return showLoginError(error.message);
  location.reload();
}

export async function logout() {
  await state.db.auth.signOut();
  location.reload();
}

async function ensureProfile() {
  const id = state.user.id;
  const email = state.user.email || "";
  const isStaffLogin = staffEmailDomains.some(domain => email.endsWith(domain));
  const fullName = state.user.user_metadata?.full_name || state.user.user_metadata?.name || email || "User";
  let { data, error } = await state.db.from("profiles").select("*").eq("id", id).maybeSingle();
  if (error && error.code !== "PGRST116") throw Error(error.message);

  if (!data) {
    if (isStaffLogin) throw Error("This employee login is not linked to a user profile. Ask a manager to recreate the login.");
    const invited = await inviteForEmail(email);
    if (!invited) throw Error("This Google account is not invited. Ask a manager to add it in Users first.");
    const insert = await state.db.from("profiles").insert({
      id,
      full_name: invited.full_name || fullName,
      role: invited.role || "manager",
      login_type: "google",
      employee_id: invited.employee_id || null,
      branch_id: invited.branch_id || null,
      branch_ids: invited.branch_ids || (invited.branch_id ? [invited.branch_id] : null),
      active: true,
    }).select("*").single();
    if (insert.error) throw Error(insert.error.message);
    data = insert.data;
  }

  if (data.active === false) throw Error("This user is inactive.");
  state.profile = data;
  state.role = (data.role || "staff").toLowerCase();
  if (!["manager", "staff"].includes(state.role)) state.role = "staff";
}

async function inviteForEmail(email) {
  if (!email) return null;
  const { data, error } = await state.db
    .from("user_invites")
    .select("*")
    .eq("email", email.toLowerCase())
    .eq("active", true)
    .maybeSingle();
  if (error && error.code !== "PGRST116") return null;
  return data || null;
}

async function ensureBranches() {
  try {
    const b = await safeSelect("branches", "*");
    if (!b.length) await state.db.from("branches").insert(CONFIG.defaultBranches);
  } catch (e) {}
}

export async function loadBranches() {
  try {
    state.branches = await safeSelect("branches", "*", { order: "name" });
  } catch (e) {
    state.branches = CONFIG.defaultBranches;
  }
  const profileBranches = Array.isArray(state.profile?.branch_ids) ? state.profile.branch_ids.filter(Boolean) : [];
  state.allowedBranchIds = profileBranches.length ? profileBranches : (state.profile?.branch_id ? [state.profile.branch_id] : state.branches.map(b => b.id));
  if (!state.allowedBranchIds.length) state.allowedBranchIds = state.branches.map(b => b.id);
  if (!state.allowedBranchIds.includes(state.currentBranchId)) {
    state.currentBranchId = state.allowedBranchIds[0] || state.branches[0]?.id || "carlton";
    localStorage.setItem("mandina_branch", state.currentBranchId);
  }
  if (!state.branches.find(b => b.id === state.currentBranchId)) state.currentBranchId = state.branches[0]?.id || "carlton";
}

function showLoginError(message) {
  const box = $("loginError");
  if (!message) {
    box.textContent = "";
    box.classList.add("hidden");
    return;
  }
  box.textContent = message;
  box.classList.remove("hidden");
}
