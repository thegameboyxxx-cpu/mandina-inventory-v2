import { state, isManager } from "./state.js";
import { $, esc, toast } from "./utils.js";
import { renderDashboard } from "./modules/dashboard.js";
import { renderSuppliers } from "./modules/suppliers.js";
import { renderItems } from "./modules/items.js";
import { renderItemsSimple } from "./modules/itemsSimple.js";
import { renderPurchaseOrders } from "./modules/purchaseOrders.js";
import { renderReceiving } from "./modules/receiving.js";
import { renderProduction } from "./modules/production.js";
import { renderStock } from "./modules/stock.js";


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
  sel.innerHTML = state.branches.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
  sel.value = state.currentBranchId;
  sel.disabled = !isManager();
}

export function setPage(page){
  state.page = page;
  document.querySelectorAll("#nav button").forEach(b=>b.classList.toggle("active", b.dataset.page===page));
  $("sidebar").classList.remove("open");
  refreshCurrent();
}

export async function refreshCurrent(){
  const titles = { dashboard:"Dashboard", suppliers:"Suppliers", items:"Items", itemsSimple:"Items Simple", purchase:"Purchase Orders", receiving:"Receiving", stock:"Stock", production:"Production" };
  $("pageTitle").textContent = titles[state.page] || "Mandina";
  if(state.page === "dashboard") return renderDashboard();
  if(state.page === "suppliers") return renderSuppliers();
  if(state.page === "items") return renderItems();
  if(state.page === "itemsSimple") return renderItemsSimple();
  if(state.page === "purchase") return renderPurchaseOrders();
  if(state.page === "receiving") return renderReceiving();
  if(state.page === "stock") return renderStock();
  if(state.page === "production") return renderProduction();
}

export function bindNavigation(){
  document.querySelectorAll("#nav button").forEach(btn=>{
    btn.onclick = ()=>{
      const page = btn.dataset.page;
      if(btn.classList.contains("soon") && page !== "receiving"){
        toast("This module is planned. We will build it in the next phases.");
        return;
      }
      setPage(page);
    };
  });
}
