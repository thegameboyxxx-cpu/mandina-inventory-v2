import { state, isManager, canSwitchBranches } from "./state.js";
import { $, esc, toast } from "./utils.js";
import { renderDashboard } from "./modules/dashboard.js";
import { renderAlerts } from "./modules/alerts.js";
import { renderUsers } from "./modules/users.js";
import { renderSuppliers } from "./modules/suppliers.js";
import { renderItemsSimple } from "./modules/itemsSimple.js";
import { renderProducedItems } from "./modules/producedItems.js";
import { renderPurchaseOrders } from "./modules/purchaseOrders.js";
import { renderReceiving } from "./modules/receiving.js";
import { renderProduction } from "./modules/production.js";
import { renderStock } from "./modules/stock.js";
import { renderCounts } from "./modules/counts.js";
import { renderMenuItems } from "./modules/menuItems.js";
import { renderWaste } from "./modules/waste.js";
import { renderSales } from "./modules/sales.js";
import { renderEmployees } from "./modules/employees.js";
import { renderShifts } from "./modules/shifts.js";
import { renderTimeClock } from "./modules/timeClock.js";
import { renderStaffMeal } from "./modules/staffMeal.js";
import { renderPayroll } from "./modules/payroll.js";


export function renderShell(){
  $("loginPage").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("profileLine").textContent = `${state.profile?.full_name || state.user.email}`;
  $("roleChip").textContent = isManager() ? "Manager" : "Staff";
  document.querySelectorAll("[data-manager='true']").forEach(el => {
    el.style.display = isManager() ? "" : "none";
  });
  renderBranchSelect();
}

export function renderBranchSelect(){
  const sel = $("branchSelect");
  const allowed = state.allowedBranchIds?.length ? new Set(state.allowedBranchIds) : null;
  const branches = allowed ? state.branches.filter(b => allowed.has(b.id)) : state.branches;
  sel.innerHTML = branches.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
  sel.value = state.currentBranchId;
  sel.disabled = !canSwitchBranches();
}

export function setPage(page){
  state.page = page;
  document.querySelectorAll("#nav button").forEach(b=>b.classList.toggle("active", b.dataset.page===page));
  $("sidebar").classList.remove("open");
  refreshCurrent();
}

export async function refreshCurrent(){
  const titles = { dashboard:"Dashboard", alerts:"Alerts", users:"Users", suppliers:"Suppliers", items:"Items", producedItems:"Produced Items", menuItems:"Menu Items", purchase:"Purchase Orders", receiving:"Receiving", stock:"Stock", production:"Production", counts:"Daily Count", waste:"Wastage", sales:"Sales", employees:"Employees", shifts:"Shift Planner", timeclock:"Time Clock", staffmeal:"Staff Meal", payroll:"Payroll" };
  $("pageTitle").textContent = titles[state.page] || "Mandina";
  if(state.page === "dashboard") return renderDashboard();
  if(state.page === "alerts") return renderAlerts();
  if(state.page === "users") return renderUsers();
  if(state.page === "suppliers") return renderSuppliers();
  if(state.page === "items") return renderItemsSimple();
  if(state.page === "producedItems") return renderProducedItems();
  if(state.page === "menuItems") return renderMenuItems();
  if(state.page === "purchase") return renderPurchaseOrders();
  if(state.page === "receiving") return renderReceiving();
  if(state.page === "stock") return renderStock();
  if(state.page === "production") return renderProduction();
  if(state.page === "counts") return renderCounts();
  if(state.page === "waste") return renderWaste();
  if(state.page === "sales") return renderSales();
  if(state.page === "employees") return renderEmployees();
  if(state.page === "shifts") return renderShifts();
  if(state.page === "timeclock") return renderTimeClock();
  if(state.page === "staffmeal") return renderStaffMeal();
  if(state.page === "payroll") return renderPayroll();
}

export function bindNavigation(){
  document.querySelectorAll("#nav button").forEach(btn=>{
    btn.onclick = ()=>{
      const page = btn.dataset.page;
      if(btn.classList.contains("soon") && !["receiving", "counts", "waste", "sales", "timeclock", "staffmeal", "payroll"].includes(page)){
        toast("This module is planned. We will build it in the next phases.");
        return;
      }
      setPage(page);
    };
  });
}
