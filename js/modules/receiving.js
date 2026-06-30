import { state } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow } from "../services/db.js";
import { loadItems, loadItemDeps } from "./items.js";
import { supplierName } from "./suppliers.js";

let filters = { supplier_id: "", search: "" };
let noteFilters = { supplier_id:"", from:"", to:"", search:"", payment_status:"" };
let poList = [], items = [], suppliers = [], receivingNotes = [], receivingLines = [];

const sameUnit = (a,b)=>String(a||"").toLowerCase().trim()===String(b||"").toLowerCase().trim();
const item = id => items.find(i=>i.id===id);
const supplier = id => suppliers.find(s=>s.id===id);
const poNo = po => po?.po_number || `PO-${String(po?.id || "").slice(0,8)}`;
const rnNo = rn => rn?.grn_number || rn?.receiving_number || `RN-${String(rn?.id || "").slice(0,8)}`;
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";

function branchRecord(){ return (state.branches || []).find(b => b.id === state.currentBranchId) || {}; }
function branchName(){ const b = branchRecord(); return b.name || b.branch_name || b.title || state.currentBranchId || ""; }
function branchAddress(){ const b = branchRecord(); return b.address || b.full_address || b.street_address || b.location || ""; }
function branchPhone(){ const b = branchRecord(); return b.phone || b.telephone || b.mobile || b.contact_phone || ""; }
function companyName(){ return "Mandina Kitchen"; }
function supplierEmail(s){ return s?.email || s?.company_email || s?.contact_email || ""; }
function help(text){ return `<div class="muted" style="font-size:11px;line-height:1.25;margin-top:3px">${esc(text)}</div>`; }

function receivedLineValue(line){
  if(line.line_total !== null && line.line_total !== undefined) return Number(line.line_total || 0);
  const price = Number(line.actual_unit_price || line.unit_price || 0);
  if(line.secondary_qty !== null && line.secondary_qty !== undefined && Number(line.secondary_qty || 0) > 0) return Number(line.secondary_qty || 0) * price;
  if(line.cost_qty !== null && line.cost_qty !== undefined && Number(line.cost_qty || 0) > 0) return Number(line.cost_qty || 0) * price;
  return Number(line.accepted_qty || 0) * price;
}
function itemConversionFactor(it){
  const receivingUnit = it?.receiving_unit || it?.purchase_package_type || "";
  const stockUnit = it?.stock_unit || "";
  const pkgUnit = it?.purchase_package_unit || "";
  const pkgQty = Number(it?.purchase_package_qty || it?.package_quantity || 0);
  if(receivingUnit && stockUnit && !sameUnit(receivingUnit, stockUnit) && pkgQty > 0){
    if(!pkgUnit || sameUnit(pkgUnit, stockUnit)) return pkgQty;
  }
  return 1;
}
function paymentBadge(note){ const s=note.payment_status || "unpaid"; const cls=s==="paid"?"green":s==="partial"?"gold":"red"; return `<span class="badge ${cls}">${esc(s)}</span>`; }
function unpaidAmount(n){ return Math.max(0, Number(n.total_amount||0)-Number(n.paid_amount||0)); }
function notePo(note){ return poList.find(p=>p.id===(note.po_id||note.purchase_order_id)) || {}; }

async function loadAll(){
  await loadItemDeps(); await loadItems();
  items=state.items||[]; suppliers=state.suppliers||[];
  poList = await safeSelect("purchase_orders","*", { eq:{branch_id:state.currentBranchId}, order:"created_at", ascending:false }).catch(()=>[]);
  poList = poList.filter(po=>["approved","partially_received"].includes(po.status||""));
  receivingNotes = await safeSelect("receiving_notes","*", { eq:{branch_id:state.currentBranchId}, order:"created_at", ascending:false }).catch(()=>[]);
  receivingLines = await safeSelect("receiving_note_lines","*").catch(()=>[]);
}

export async function renderReceiving(){
  const content=$("content");
  content.innerHTML='<div class="card">Loading receiving...</div>';
  try{
    await loadAll();
    content.innerHTML=`
      <div class="card">
        <div class="section-head"><h2>Receiving</h2><div class="toolbar">
          <select id="recSupplier"><option value="">All suppliers</option>${suppliers.map(s=>`<option value="${esc(s.id)}">${esc(supplierName(s))}</option>`).join("")}</select>
          <input id="recSearch" class="input" placeholder="Search PO...">
        </div></div>
        <div class="muted" style="margin-bottom:12px">Branch: <b>${esc(branchName())}</b>. Approved and partially received purchase orders.</div>
        <div id="receivingTable"></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Receiving Notes</h2></div>
        <div class="toolbar" style="margin-bottom:12px;flex-wrap:wrap">
          <select id="rnSupplier"><option value="">All suppliers</option>${suppliers.map(s=>`<option value="${esc(s.id)}">${esc(supplierName(s))}</option>`).join("")}</select>
          <select id="rnPayment"><option value="">All payment</option><option value="unpaid">Unpaid</option><option value="partial">Partial</option><option value="paid">Paid</option></select>
          <input id="rnFrom" type="date" class="input">
          <input id="rnTo" type="date" class="input">
          <input id="rnSearch" class="input" placeholder="Search RN / PO number...">
        </div>
        <div id="rnSummary" class="muted" style="margin-bottom:10px"></div>
        <div id="recentReceiving"></div>
      </div>`;
    $("recSupplier").value=filters.supplier_id; $("recSearch").value=filters.search;
    $("recSupplier").onchange=e=>{filters.supplier_id=e.target.value; renderTables();};
    $("recSearch").oninput=e=>{filters.search=e.target.value; renderTables();};
    $("rnSupplier").value=noteFilters.supplier_id; $("rnFrom").value=noteFilters.from; $("rnTo").value=noteFilters.to; $("rnSearch").value=noteFilters.search; $("rnPayment").value=noteFilters.payment_status;
    $("rnSupplier").onchange=e=>{noteFilters.supplier_id=e.target.value; renderRecentNotes();};
    $("rnPayment").onchange=e=>{noteFilters.payment_status=e.target.value; renderRecentNotes();};
    $("rnFrom").onchange=e=>{noteFilters.from=e.target.value; renderRecentNotes();};
    $("rnTo").onchange=e=>{noteFilters.to=e.target.value; renderRecentNotes();};
    $("rnSearch").oninput=e=>{noteFilters.search=e.target.value; renderRecentNotes();};
    renderTables();
  }catch(e){content.innerHTML=showError(e.message);}
}
function statusBadge(status){ const s=status||"approved"; const cls=s==="approved"?"blue":s==="partially_received"?"gold":s==="fully_received"?"green":"gold"; return `<span class="badge ${cls}">${esc(s)}</span>`; }

function renderTables(){
  const q=filters.search.toLowerCase();
  const rows=poList.filter(po=>(!filters.supplier_id||po.supplier_id===filters.supplier_id)&&JSON.stringify(po).toLowerCase().includes(q));
  $("receivingTable").innerHTML=`<table><thead><tr><th>PO</th><th>Branch</th><th>PO Date</th><th>Supplier</th><th>Status</th><th>Total</th><th></th></tr></thead><tbody>
  ${rows.map(po=>`<tr><td><b>${esc(poNo(po))}</b></td><td>${esc(branchName())}</td><td>${esc(po.order_date||(po.created_at||"").slice(0,10))}</td><td>${esc(supplierName(supplier(po.supplier_id)))}</td><td>${statusBadge(po.status)}</td><td>${money(po.total_amount)}</td><td><button class="btn small receive-po" data-id="${esc(po.id)}">Receive</button></td></tr>`).join("")||'<tr><td colspan="7" class="muted">No approved purchase orders ready for receiving.</td></tr>'}</tbody></table>`;
  document.querySelectorAll(".receive-po").forEach(btn=>btn.onclick=()=>openReceivingModal(poList.find(po=>po.id===btn.dataset.id)));
  renderRecentNotes();
}

function deliveryStatusForNote(note){
  const lines = receivingLines.filter(l => (l.grn_id || l.receiving_note_id) === note.id);
  let hasOver = false, hasShort = false, hasMatched = false;
}

function _dummyDelivery(){}
