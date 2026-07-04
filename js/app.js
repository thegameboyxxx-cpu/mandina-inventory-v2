import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { $, showError, enhanceTables } from "./utils.js";
import { initAuth, loginGoogle, loginStaff, logout } from "./auth.js";
import { renderShell, bindNavigation, refreshCurrent, renderBranchSelect } from "./ui.js";

function bindResponsiveTables() {
  ["content", "modalRoot"].forEach(id => {
    const el = $(id);
    if (!el) return;
    new MutationObserver(() => enhanceTables(el)).observe(el, { childList: true, subtree: true });
  });
}

function changeBranch(value) {
  state.currentBranchId = value;
  localStorage.setItem("mandina_branch", state.currentBranchId);
  renderBranchSelect();
  refreshCurrent();
}

async function init() {
  state.db = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
  bindResponsiveTables();

  $("loginBtn").onclick = loginGoogle;
  $("staffLoginBtn").onclick = loginStaff;
  $("staffPassword").onkeydown = e => {
    if (e.key === "Enter") loginStaff();
  };
  $("logoutBtn").onclick = logout;
  $("refreshBtn").onclick = refreshCurrent;
  $("sidebarLogoutBtn").onclick = logout;
  $("sidebarRefreshBtn").onclick = refreshCurrent;
  $("mobileMenuBtn").onclick = () => $("sidebar").classList.toggle("open");
  $("branchSelect").onchange = e => changeBranch(e.target.value);
  $("sidebarBranchSelect").onchange = e => changeBranch(e.target.value);

  bindNavigation();
  if (!await initAuth()) return;
  renderShell();
  await refreshCurrent();
}

init().catch(e => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:20px">${showError(e.message)}</div>`;
});
