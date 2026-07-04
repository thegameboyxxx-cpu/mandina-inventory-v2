import { state, canSeeFinancials } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow } from "../services/db.js";
import { loadItems, loadItemDeps } from "./items.js";
import { supplierName } from "./suppliers.js";

let filters = { supplier_id: "", search: "" };
let noteFilters = { supplier_id:"", from:"", to:"", search:"", payment_status:"", delivery_status:"", item_id:"" };
let poList = [], allPurchaseOrders = [], items = [], suppliers = [], receivingNotes = [], receivingLines = [];

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
function help(text){ return ` <span title="${esc(text)}" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid #aaa;color:#666;font-size:11px;font-weight:700;cursor:help;margin-left:4px;vertical-align:middle">i</span>`; }

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
function notePo(note){ return allPurchaseOrders.find(p=>p.id===(note.po_id||note.purchase_order_id)) || {}; }

async function loadAll(){
  await loadItemDeps(); await loadItems();
  items=state.items||[]; suppliers=state.suppliers||[];
  allPurchaseOrders = await safeSelect("purchase_orders","*", { eq:{branch_id:state.currentBranchId}, order:"created_at", ascending:false }).catch(()=>[]);
  poList = allPurchaseOrders.filter(po=>["approved","partially_received"].includes(po.status||""));
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
          <select id="rnDeliveryStatus"><option value="">All delivery</option><option value="completed">Completed PO</option><option value="partial">Partial</option><option value="matched">Matched delivery</option><option value="over">Over received</option></select>
          <select id="rnItemFilter"><option value="">All items</option>${items.map(i=>`<option value="${esc(i.id)}">${esc(itemLabel(i))}</option>`).join("")}</select>
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
    $("rnSupplier").value=noteFilters.supplier_id; $("rnFrom").value=noteFilters.from; $("rnTo").value=noteFilters.to; $("rnSearch").value=noteFilters.search; $("rnPayment").value=noteFilters.payment_status; $("rnDeliveryStatus").value=noteFilters.delivery_status; $("rnItemFilter").value=noteFilters.item_id;
    $("rnSupplier").onchange=e=>{noteFilters.supplier_id=e.target.value; renderRecentNotes();};
    $("rnPayment").onchange=e=>{noteFilters.payment_status=e.target.value; renderRecentNotes();};
    $("rnDeliveryStatus").onchange=e=>{noteFilters.delivery_status=e.target.value; renderRecentNotes();};
    $("rnItemFilter").onchange=e=>{noteFilters.item_id=e.target.value; renderRecentNotes();};
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
  $("receivingTable").innerHTML=`<table><thead><tr><th>PO</th><th>Branch</th><th>PO Date</th><th>Supplier</th><th>Status</th>${canSeeFinancials() ? "<th>Total</th>" : ""}<th></th></tr></thead><tbody>
  ${rows.map(po=>`<tr><td><b>${esc(poNo(po))}</b></td><td>${esc(branchName())}</td><td>${esc(po.order_date||(po.created_at||"").slice(0,10))}</td><td>${esc(supplierName(supplier(po.supplier_id)))}</td><td>${statusBadge(po.status)}</td>${canSeeFinancials() ? `<td>${money(po.total_amount)}</td>` : ""}<td><button class="btn small receive-po" data-id="${esc(po.id)}">Receive</button></td></tr>`).join("")||`<tr><td colspan="${canSeeFinancials() ? 7 : 6}" class="muted">No approved purchase orders ready for receiving.</td></tr>`}</tbody></table>`;
  document.querySelectorAll(".receive-po").forEach(btn=>btn.onclick=()=>openReceivingModal(poList.find(po=>po.id===btn.dataset.id)));
  renderRecentNotes();
}

function deliveryStatusForNote(note){
  const lines = receivingLines.filter(l => (l.grn_id || l.receiving_note_id) === note.id);
  const po = notePo(note);
  if(!lines.length) return { key:"unknown", label:"Unknown", badge:"gold", text:"No line details found" };

  let hasOver = false;
  let completesAnyLine = false;
  let allNoteLinesComplete = true;
  let hasShortThisDelivery = false;

  for(const l of lines){
    const poLineId = l.po_line_id || l.purchase_order_line_id;
    const ordered = Number(l.ordered_qty || 0);
    const acceptedNow = Number(l.accepted_qty || l.received_qty || 0);
    const rejected = Number(l.rejected_qty || 0);
    const noteTime = new Date(note.created_at || note.received_date || note.received_at || 0).getTime();

    const previousAccepted = receivingLines
      .filter(x => {
        if((x.po_line_id || x.purchase_order_line_id) !== poLineId) return false;
        const rn = receivingNotes.find(n => n.id === (x.grn_id || x.receiving_note_id));
        if(!rn) return false;
        if((rn.po_id || rn.purchase_order_id) !== (po.id || note.po_id || note.purchase_order_id)) return false;
        const rnTime = new Date(rn.created_at || rn.received_date || rn.received_at || 0).getTime();
        return rnTime < noteTime;
      })
      .reduce((sum,x)=>sum+Number(x.accepted_qty || x.received_qty || 0),0);

    const totalAfterThisNote = previousAccepted + acceptedNow;
    const remainingBefore = Math.max(0, ordered - previousAccepted);

    if(acceptedNow > remainingBefore) hasOver = true;
    if(rejected > 0 || acceptedNow < remainingBefore) hasShortThisDelivery = true;
    if(totalAfterThisNote >= ordered && ordered > 0) completesAnyLine = true;
    if(ordered > 0 && totalAfterThisNote < ordered) allNoteLinesComplete = false;
  }

  if(hasOver) return { key:"over", label:"Over received", badge:"red", text:"Received more than remaining PO qty" };
  if(completesAnyLine && allNoteLinesComplete) return { key:"completed", label:"Completed PO", badge:"green", text:"This receiving completed the ordered qty" };
  if(hasShortThisDelivery) return { key:"partial", label:"Partial", badge:"gold", text:"This receiving did not complete the PO qty" };
  return { key:"matched", label:"Matched delivery", badge:"blue", text:"This delivery matched the remaining qty for its lines" };
}

function filteredNotes(){
  const q=noteFilters.search.toLowerCase();
  return receivingNotes.filter(n=>{
    const po=notePo(n), d=(n.received_date||n.received_at||n.created_at||"").slice(0,10);
    if(noteFilters.supplier_id && n.supplier_id!==noteFilters.supplier_id) return false;
    if(noteFilters.payment_status && (n.payment_status || "unpaid")!==noteFilters.payment_status) return false;
    if(noteFilters.delivery_status && deliveryStatusForNote(n).key !== noteFilters.delivery_status) return false;
    if(noteFilters.item_id){
      const lines = receivingLines.filter(l => (l.grn_id || l.receiving_note_id) === n.id);
      if(!lines.some(l => l.item_id === noteFilters.item_id)) return false;
    }
    if(noteFilters.from && d < noteFilters.from) return false;
    if(noteFilters.to && d > noteFilters.to) return false;
    return `${rnNo(n)} ${poNo(po)} ${JSON.stringify(n)}`.toLowerCase().includes(q);
  });
}

function renderRecentNotes(){
  const rows=filteredNotes();
  const total=rows.reduce((a,n)=>a+Number(n.total_amount||0),0);
  const paid=rows.reduce((a,n)=>a+Number(n.paid_amount||0),0);
  const outstanding=rows.reduce((a,n)=>a+unpaidAmount(n),0);
  $("rnSummary").innerHTML=canSeeFinancials()
    ? `Notes: <b>${rows.length}</b> | Total Received: <b>${money(total)}</b> | Paid: <b>${money(paid)}</b> | Outstanding Payable: <b>${money(outstanding)}</b>`
    : `Notes: <b>${rows.length}</b>`;

  $("recentReceiving").innerHTML=`<table><thead><tr><th>RN</th><th>Purchase Order</th><th>Supplier</th><th>Date</th><th>Delivery Status</th>${canSeeFinancials() ? "<th>Total</th><th>Paid</th><th>Payment</th>" : ""}<th></th></tr></thead><tbody>
  ${rows.map(rn=>{
    const po=notePo(rn);
    const ds=deliveryStatusForNote(rn);
    return `<tr>
      <td><b>${esc(rnNo(rn))}</b></td>
      <td><b>${esc(poNo(po))}</b><div class="muted">${esc(po.status || "")}</div></td>
      <td>${esc(supplierName(supplier(rn.supplier_id||po.supplier_id)))}</td>
      <td>${esc((rn.received_date||rn.received_at||rn.created_at||"").slice(0,10))}</td>
      <td><span class="badge ${esc(ds.badge)}">${esc(ds.label)}</span><div class="muted">${esc(ds.text)}</div></td>
      ${canSeeFinancials() ? `<td>${money(rn.total_amount)}</td><td>${money(rn.paid_amount||0)}</td><td>${paymentBadge(rn)}</td>` : ""}
      <td><button class="btn secondary small open-rn" data-id="${esc(rn.id)}">Open</button>${canSeeFinancials() ? `<button class="btn secondary small pay-rn" data-id="${esc(rn.id)}">Pay</button><button class="btn secondary small copy-rn" data-id="${esc(rn.id)}">Copy</button><button class="btn secondary small pdf-rn" data-id="${esc(rn.id)}">PDF</button><button class="btn secondary small email-rn" data-id="${esc(rn.id)}">Email</button>` : ""}</td>
    </tr>`;
  }).join("")||`<tr><td colspan="${canSeeFinancials() ? 9 : 6}" class="muted">No receiving notes found.</td></tr>`}</tbody></table>`;

  document.querySelectorAll(".open-rn").forEach(btn=>btn.onclick=()=>openReceivingNote(receivingNotes.find(rn=>rn.id===btn.dataset.id)));
  if(canSeeFinancials()){
    document.querySelectorAll(".copy-rn").forEach(btn=>btn.onclick=()=>copyReceivingNote(receivingNotes.find(rn=>rn.id===btn.dataset.id)));
    document.querySelectorAll(".pdf-rn").forEach(btn=>btn.onclick=()=>printReceivingNote(receivingNotes.find(rn=>rn.id===btn.dataset.id)));
    document.querySelectorAll(".email-rn").forEach(btn=>btn.onclick=()=>emailReceivingNote(receivingNotes.find(rn=>rn.id===btn.dataset.id)));
    document.querySelectorAll(".pay-rn").forEach(btn=>btn.onclick=()=>openPaymentModal(receivingNotes.find(rn=>rn.id===btn.dataset.id)));
  }
}

async function getPoLines(poId){
  return await safeSelect("purchase_order_lines","*",{eq:{purchase_order_id:poId},order:"sort_order"}).catch(()=>[]);
}

function receivedBefore(poId,poLineId){
  const ids = new Set(receivingNotes.filter(n=>(n.po_id||n.purchase_order_id)===poId).map(n=>n.id));
  return receivingLines
    .filter(l=>ids.has(l.grn_id||l.receiving_note_id)&&(l.po_line_id||l.purchase_order_line_id)===poLineId)
    .reduce((s,l)=>s+Number(l.accepted_qty||0),0);
}

async function openReceivingModal(po){
  if(!po) return toast("PO not found.","error");

  const poLines = await getPoLines(po.id);
  const local = poLines.map(line=>{
    const it = item(line.item_id);
    const unit = line.order_unit || line.unit || it?.receiving_unit || it?.stock_unit || "";
    const costUnit = line.cost_unit || it?.cost_unit || it?.stock_unit || unit;
    const already = receivedBefore(po.id,line.id);
    const ordered = Number(line.ordered_qty||0);

    return {
      po_line_id:line.id,
      item_id:line.item_id,
      item_name:itemLabel(it),
      ordered_qty:ordered,
      received_before_qty:already,
      delivered_qty:0,
      accepted_qty:0,
      rejected_qty:0,
      unit,
      stock_unit:it?.stock_unit || unit,
      cost_unit:costUnit,
      conversion_factor:itemConversionFactor(it),
      actual_cost_qty:sameUnit(unit,costUnit)?null:0,
      unit_price:Number(line.unit_price||0),
      reject_reason:""
    };
  });

  openModal(`<div class="modal-head"><h3>Receive ${esc(poNo(po))}</h3><button class="btn secondary small" onclick="closeModal()">✕</button></div>
  <form id="receivingForm">
    <div class="modal-body">
      <div class="form-grid">
        <div><label>Branch</label><input class="input" value="${esc(branchName())}" disabled></div>
        <div><label>Supplier</label><input class="input" value="${esc(supplierName(supplier(po.supplier_id)))}" disabled></div>
        <div><label>Receiving Date</label><input name="received_date" type="date" class="input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="full"><label>Receiving Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
      </div>
      <div style="margin-top:16px" id="receivingLinesBox"></div>
      ${canSeeFinancials() ? `<div style="text-align:right;font-weight:900;font-size:20px;margin-top:14px">Receiving Total: <span id="receivingTotal">$0.00</span></div>` : ""}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn green">Save Receiving</button>
    </div>
  </form>`);

  const stockQtyFromLine = line => Number(line.accepted_qty||0) * Number(line.conversion_factor||1);
  const lineTotalFromLocal = line => !sameUnit(line.unit,line.cost_unit)
    ? Number(line.actual_cost_qty||0) * Number(line.unit_price||0)
    : Number(line.accepted_qty||0) * Number(line.unit_price||0);
  const calculateTotal = () => local.reduce((s,l)=>s+lineTotalFromLocal(l),0);

  function drawLines(){
    const anyCost = local.some(l=>!sameUnit(l.unit,l.cost_unit));

    $("receivingLinesBox").innerHTML = `<table>
      <thead>
        <tr>
          <th>Item${help("Receiving unit, billing unit, and stock conversion.")}</th>
          <th>Ordered${help("Ordered in supplier receiving unit.")}</th>
          <th>Received Before${help("Previously accepted in receiving unit.")}</th>
          <th>Delivered Now${help("What arrived now, e.g. bags/pieces.")}</th>
          <th>Accepted${help("Accepted quantity in receiving unit.")}</th>
          <th>Rejected${help("Rejected quantity in receiving unit.")}</th>
          ${anyCost ? `<th>Billing Qty${help("Invoice quantity. Example: meat pieces billed by kg.")}</th>` : ""}
          <th>Stock Add${help("How much will be added to stock unit.")}</th>
          ${canSeeFinancials() ? `<th>Total${help("Uses billing qty when billing unit differs.")}</th>` : ""}
          <th>Reject Reason</th>
        </tr>
      </thead>
      <tbody>
        ${local.map((line,index)=>{
          const needs = !sameUnit(line.unit,line.cost_unit);
          return `<tr data-row="${index}">
            <td><b>${esc(line.item_name)}</b>
              <div class="muted">Receive in ${esc(line.unit)} / Stock in ${esc(line.stock_unit)}${Number(line.conversion_factor||1)!==1 ? ` / 1 ${esc(line.unit)} = ${qty(line.conversion_factor)} ${esc(line.stock_unit)}` : ""}${needs ? ` / bill by ${esc(line.cost_unit)}` : ""}</div>
            </td>
            <td>${qty(line.ordered_qty)} ${esc(line.unit)}</td>
            <td>${qty(line.received_before_qty)} ${esc(line.unit)}</td>
            <td><input type="number" step="0.001" class="input delivered-input" data-index="${index}" value="${esc(line.delivered_qty)}" placeholder="${esc(line.unit)}"></td>
            <td><input type="number" step="0.001" class="input accepted-input" data-index="${index}" value="${esc(line.accepted_qty)}"></td>
            <td><input type="number" step="0.001" class="input rejected-input" data-index="${index}" value="${esc(line.rejected_qty)}"></td>
            ${anyCost ? `<td>${needs ? `<input type="number" step="0.001" class="input costqty-input" data-index="${index}" value="${esc(line.actual_cost_qty??"")}" placeholder="Enter ${esc(line.cost_unit)}">` : '<span class="muted">Auto</span>'}</td>` : ""}
            <td class="stock-add">${qty(stockQtyFromLine(line))} ${esc(line.stock_unit)}</td>
            ${canSeeFinancials() ? `<td class="line-total">${money(lineTotalFromLocal(line))}</td>` : ""}
            <td><input class="input reason-input" data-index="${index}" value="${esc(line.reject_reason||"")}" placeholder="Reason"></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;

    bindLineInputs();
    updateTotalsOnly();
  }

  function updateTotalsOnly(){
    local.forEach((line,index)=>{
      const totalCell = document.querySelector(`tr[data-row="${index}"] .line-total`);
      const stockCell = document.querySelector(`tr[data-row="${index}"] .stock-add`);

      if(totalCell) totalCell.textContent = money(lineTotalFromLocal(line));
      if(stockCell) stockCell.textContent = `${qty(stockQtyFromLine(line))} ${line.stock_unit || ""}`;
    });

    if($("receivingTotal")) $("receivingTotal").textContent = money(calculateTotal());
  }

  function bindLineInputs(){
    document.querySelectorAll(".delivered-input").forEach(input=>input.oninput=()=>{
      const line = local[Number(input.dataset.index)];
      line.delivered_qty = Number(input.value||0);
      line.accepted_qty = Math.max(0,Number(line.delivered_qty||0)-Number(line.rejected_qty||0));
      const a = document.querySelector(`.accepted-input[data-index="${input.dataset.index}"]`);
      if(a) a.value = line.accepted_qty;
      updateTotalsOnly();
    });

    document.querySelectorAll(".accepted-input").forEach(input=>input.oninput=()=>{
      local[Number(input.dataset.index)].accepted_qty = Number(input.value||0);
      updateTotalsOnly();
    });

    document.querySelectorAll(".rejected-input").forEach(input=>input.oninput=()=>{
      const line = local[Number(input.dataset.index)];
      line.rejected_qty = Number(input.value||0);
      line.accepted_qty = Math.max(0,Number(line.delivered_qty||0)-Number(line.rejected_qty||0));
      const a = document.querySelector(`.accepted-input[data-index="${input.dataset.index}"]`);
      if(a) a.value = line.accepted_qty;
      updateTotalsOnly();
    });

    document.querySelectorAll(".costqty-input").forEach(input=>input.oninput=()=>{
      local[Number(input.dataset.index)].actual_cost_qty = Number(input.value||0);
      updateTotalsOnly();
    });

    document.querySelectorAll(".reason-input").forEach(input=>input.oninput=()=>{
      local[Number(input.dataset.index)].reject_reason = input.value;
    });
  }

  drawLines();

  $("receivingForm").onsubmit = async event=>{
    event.preventDefault();

    const form = new FormData(event.target);
    const active = local.filter(l=>Number(l.delivered_qty||0)>0 || Number(l.accepted_qty||0)>0 || Number(l.rejected_qty||0)>0);

    if(!active.length) return toast("Enter at least one delivered quantity.","error");

    try{
      const total = calculateTotal();
      const grnNumber = `RN-${Date.now().toString().slice(-8)}`;

      const note = await insertRow("receiving_notes",{
        grn_number:grnNumber,
        receiving_number:grnNumber,
        branch_id:state.currentBranchId,
        supplier_id:po.supplier_id,
        po_id:po.id,
        purchase_order_id:po.id,
        received_date:form.get("received_date"),
        received_at:form.get("received_date"),
        notes:form.get("notes")||null,
        total_amount:total,
        status:"saved",
        payment_status:"unpaid",
        paid_amount:0,
        created_by:state.user.id
      });

      const rows = active.map((line,index)=>({
        grn_id:note.id,
        receiving_note_id:note.id,
        po_line_id:line.po_line_id,
        purchase_order_line_id:line.po_line_id,
        purchase_order_id:po.id,
        item_id:line.item_id,
        ordered_qty:Number(line.ordered_qty||0),
        delivered_qty:Number(line.delivered_qty||0),
        received_qty:Number(line.delivered_qty||0),
        accepted_qty:Number(line.accepted_qty||0),
        rejected_qty:Number(line.rejected_qty||0),
        receive_unit:line.unit,
        order_unit:line.unit,
        stock_unit:line.stock_unit,
        cost_unit:line.cost_unit,
        secondary_qty:sameUnit(line.unit,line.cost_unit)?null:Number(line.actual_cost_qty||0),
        secondary_unit:sameUnit(line.unit,line.cost_unit)?null:line.cost_unit,
        cost_qty:sameUnit(line.unit,line.cost_unit)?Number(line.accepted_qty||0):Number(line.actual_cost_qty||0),
        actual_unit_price:Number(line.unit_price||0),
        unit_price:Number(line.unit_price||0),
        rejection_reason:line.reject_reason||null,
        reject_reason:line.reject_reason||null,
        notes:null,
        sort_order:index
      }));

      const lineInsert = await state.db.from("receiving_note_lines").insert(rows);
      if(lineInsert.error) throw lineInsert.error;

      for(const line of active){
        await maybeCreateOverReceivingAlert(note,po,line);
        if(Number(line.accepted_qty||0)>0) await addStockMovement(note,po,line);
      }

      await updatePoStatus(po.id);

      toast("Receiving saved.","ok");
      closeModal();
      renderReceiving();
    }catch(error){
      toast("Receiving failed: "+error.message,"error");
    }
  };
}

async function maybeCreateOverReceivingAlert(note,po,line){
  const remainingBeforeThisReceive = Math.max(0,Number(line.ordered_qty||0)-Number(line.received_before_qty||0));
  const overQty = Math.max(0,Number(line.accepted_qty||0)-remainingBeforeThisReceive);

  if(overQty<=0) return;

  await state.db.from("over_receiving_alerts").insert({
    branch_id:state.currentBranchId,
    purchase_order_id:po.id,
    purchase_order_line_id:line.po_line_id,
    receiving_note_id:note.id,
    item_id:line.item_id,
    ordered_qty:Number(line.ordered_qty||0),
    previously_received_qty:Number(line.received_before_qty||0),
    received_now_qty:Number(line.accepted_qty||0),
    over_qty:overQty,
    unit:line.unit,
    status:"open"
  });
}

async function addStockMovement(note,po,line){
  const amount = Number(line.accepted_qty||0) * Number(line.conversion_factor||1);
  const payload = {
    branch_id:state.currentBranchId,
    item_id:line.item_id,
    movement_type:"RECEIVING",
    qty_change:amount,
    qty:amount,
    quantity:amount,
    stock_unit:line.stock_unit,
    unit:line.stock_unit,
    reference_id:note.id,
    reference_type:"receiving",
    notes:`Receiving ${rnNo(note)} from ${poNo(po)}`,
    created_by:state.user.id
  };

  const result = await state.db.from("stock_movements").insert(payload);
  if(result.error) throw result.error;
}

async function updatePoStatus(poId){
  const poLines = await safeSelect("purchase_order_lines","*",{eq:{purchase_order_id:poId}}).catch(()=>[]);
  const notesForPo = await safeSelect("receiving_notes","*",{eq:{po_id:poId}}).catch(()=>[]);
  const ids = new Set(notesForPo.map(n=>n.id));
  const allLines = await safeSelect("receiving_note_lines","*").catch(()=>[]);
  const related = allLines.filter(l=>ids.has(l.grn_id||l.receiving_note_id));

  let any=false, all=true;

  for(const pl of poLines){
    const ordered = Number(pl.ordered_qty||0);
    const received = related
      .filter(l=>(l.po_line_id||l.purchase_order_line_id)===pl.id)
      .reduce((s,l)=>s+Number(l.accepted_qty||0),0);

    if(received>0) any=true;
    if(received<ordered) all=false;
  }

  const status = all ? "fully_received" : any ? "partially_received" : "approved";
  const result = await state.db.from("purchase_orders").update({status,updated_at:new Date().toISOString()}).eq("id",poId);
  if(result.error) throw result.error;
}

function rnLines(note){
  return receivingLines.filter(l=>(l.grn_id||l.receiving_note_id)===note.id);
}

function rnText(note){
  const po = notePo(note);
  const lines = rnLines(note);

  return [
    `Receiving Note: ${rnNo(note)}`,
    `Company: ${companyName()}`,
    `Branch: ${branchName()}`,
    branchAddress()?`Address: ${branchAddress()}`:"",
    `Branch Phone: ${branchPhone() || "-"}`,
    `PO: ${poNo(po)}`,
    `Supplier: ${supplierName(supplier(note.supplier_id))}`,
    `Date: ${(note.received_date||note.received_at||note.created_at||"").slice(0,10)}`,
    "",
    ...lines.map((l,i)=>`${i+1}. ${itemLabel(item(l.item_id))} - Delivered ${qty(l.delivered_qty||l.received_qty)} ${l.receive_unit||l.order_unit||l.stock_unit||""}, Accepted ${qty(l.accepted_qty)}, Billing ${l.secondary_qty || l.cost_qty || l.accepted_qty} ${l.secondary_unit || l.cost_unit || l.receive_unit || ""}, Total ${money(receivedLineValue(l))}${l.rejection_reason||l.reject_reason?" - "+(l.rejection_reason||l.reject_reason):""}`),
    "",
    `Total: ${money(note.total_amount)}`,
    `Paid: ${money(note.paid_amount||0)}`,
    `Outstanding: ${money(unpaidAmount(note))}`
  ].filter(Boolean).join("\n");
}

function copyReceivingNote(note){
  navigator.clipboard.writeText(rnText(note));
  toast("Receiving note copied.","ok");
}

function emailReceivingNote(note){
  mailTo(supplierEmail(supplier(note.supplier_id)),`Receiving Note ${rnNo(note)} - ${branchName()}`,rnText(note));
}

function openPrintWindow(title, bodyHtml){
  const w = window.open("","_blank");
  if(!w) return toast("Popup blocked. Allow popups to print PDF.","error");

  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;padding:28px;color:#222}
    table{width:100%;border-collapse:collapse;margin-top:14px}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px}
    th{background:#f6f0e6}
    .total{text-align:right;font-weight:bold;font-size:18px;margin-top:18px}
    .muted{color:#666;font-size:12px}
  </style></head><body>${bodyHtml}</body></html>`);

  w.document.close();
  w.focus();
  setTimeout(()=>w.print(),250);
}

function printReceivingNote(note){
  const lines = rnLines(note);
  const rows = lines.map((l,i)=>`<tr>
    <td>${i+1}</td>
    <td>${esc(itemLabel(item(l.item_id)))}</td>
    <td>${qty(l.delivered_qty||l.received_qty)} ${esc(l.receive_unit||"")}</td>
    <td>${qty(l.accepted_qty)}</td>
    <td>${qty(l.rejected_qty||0)}</td>
    <td>${l.secondary_qty?`${qty(l.secondary_qty)} ${esc(l.secondary_unit||"")}`:(l.cost_qty?`${qty(l.cost_qty)} ${esc(l.cost_unit||"")}`:"Auto")}</td>
    <td>${money(receivedLineValue(l))}</td>
  </tr>`).join("");

  openPrintWindow(`RN ${rnNo(note)}`,`<h1>Receiving Note ${esc(rnNo(note))}</h1>
    <div class="muted">Branch: ${esc(branchName())}</div>
    <div class="muted">Supplier: ${esc(supplierName(supplier(note.supplier_id)))}</div>
    <table>
      <thead><tr><th>#</th><th>Item</th><th>Delivered</th><th>Accepted</th><th>Rejected</th><th>Billing</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="total">Total: ${money(note.total_amount)}</div>`);
}

function openReceivingNote(note){
  if(!note) return;

  const lines = rnLines(note);

  openModal(`<div class="modal-head"><h3>Receiving Note ${esc(rnNo(note))}</h3><button class="btn secondary small" onclick="closeModal()">✕</button></div>
  <div class="modal-body">
    <div class="grid cards" style="grid-template-columns:repeat(${canSeeFinancials() ? 4 : 2},minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Branch</div><div><b>${esc(branchName())}</b></div></div>
      <div class="card"><div class="stat-title">Supplier</div><div><b>${esc(supplierName(supplier(note.supplier_id)))}</b></div></div>
      ${canSeeFinancials() ? `<div class="card"><div class="stat-title">Payment</div><div><b>${esc(note.payment_status||"unpaid")}</b><br>${money(note.paid_amount||0)} paid</div></div>
      <div class="card"><div class="stat-title">Outstanding</div><div><b>${money(unpaidAmount(note))}</b></div></div>` : ""}
    </div>
    <table>
      <thead><tr><th>Item</th><th>Delivered</th><th>Accepted</th><th>Rejected</th>${canSeeFinancials() ? "<th>Billing</th><th>Total</th>" : ""}<th>Reason</th></tr></thead>
      <tbody>${lines.map(l=>`<tr>
        <td>${esc(itemLabel(item(l.item_id)))}</td>
        <td>${qty(l.delivered_qty||l.received_qty)} ${esc(l.receive_unit||l.order_unit||"")}</td>
        <td>${qty(l.accepted_qty)}</td>
        <td>${qty(l.rejected_qty||0)}</td>
        ${canSeeFinancials() ? `<td>${l.secondary_qty?`${qty(l.secondary_qty)} ${esc(l.secondary_unit||l.cost_unit||"")}`:(l.cost_qty?`${qty(l.cost_qty)} ${esc(l.cost_unit||"")}`:"Auto")}</td>
        <td>${money(receivedLineValue(l))}</td>` : ""}
        <td>${esc(l.rejection_reason||l.reject_reason||"")}</td>
      </tr>`).join("")}</tbody>
    </table>
  </div>
  <div class="modal-foot">
    <button class="btn secondary" onclick="closeModal()">Close</button>
    ${canSeeFinancials() ? `<button class="btn" id="copyOpenRn">Copy</button>
    <button class="btn secondary" id="pdfOpenRn">PDF</button>
    <button class="btn secondary" id="emailOpenRn">Email</button>
    <button class="btn green" id="payOpenRn">Pay</button>` : ""}
  </div>`);

  if(canSeeFinancials()){
    $("copyOpenRn").onclick = ()=>copyReceivingNote(note);
    $("pdfOpenRn").onclick = ()=>printReceivingNote(note);
    $("emailOpenRn").onclick = ()=>emailReceivingNote(note);
    $("payOpenRn").onclick = ()=>openPaymentModal(note);
  }
}

function openPaymentModal(note){
  const remaining = unpaidAmount(note);

  openModal(`<div class="modal-head"><h3>Record Payment - ${esc(rnNo(note))}</h3><button class="btn secondary small" onclick="closeModal()">✕</button></div>
  <form id="paymentForm">
    <div class="modal-body">
      <div class="form-grid">
        <div><label>Total</label><input class="input" value="${money(note.total_amount)}" disabled></div>
        <div><label>Already Paid</label><input class="input" value="${money(note.paid_amount||0)}" disabled></div>
        <div><label>Pay Amount</label><input name="amount" type="number" step="0.01" class="input" value="${remaining}"></div>
        <div><label>Payment Date</label><input name="date" type="date" class="input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div><label>Method</label><select name="method"><option>Cash</option><option>Bank Transfer</option><option>Card</option><option>Cheque</option><option>Other</option></select></div>
        <div><label>Reference</label><input name="ref" class="input"></div>
        <div class="full"><label>Notes</label><textarea name="notes" class="input"></textarea></div>
      </div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn green">Save Payment</button>
    </div>
  </form>`);

  $("paymentForm").onsubmit = async e=>{
    e.preventDefault();

    const fd = new FormData(e.target);
    const newPaid = Number(note.paid_amount||0)+Number(fd.get("amount")||0);
    const total = Number(note.total_amount||0);
    const status = newPaid<=0 ? "unpaid" : newPaid>=total ? "paid" : "partial";

    const {error} = await state.db.from("receiving_notes").update({
      paid_amount:newPaid,
      payment_status:status,
      payment_date:fd.get("date"),
      payment_method:fd.get("method"),
      payment_reference:fd.get("ref")||null,
      payment_notes:fd.get("notes")||null,
      updated_at:new Date().toISOString()
    }).eq("id",note.id);

    if(error) return toast("Payment failed: "+error.message,"error");

    toast("Payment saved.","ok");
    closeModal();
    renderReceiving();
  };
}
