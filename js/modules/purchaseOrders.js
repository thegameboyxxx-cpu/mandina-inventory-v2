import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow, updateRow, deleteRows } from "../services/db.js";
import { loadItems, loadItemDeps } from "./items.js";
import { supplierName } from "./suppliers.js";

let poFilters = { status:"", supplier_id:"", search:"" };
let stockBalances = [];
let receivingNotes = [];
let receivingLines = [];

function getSupplier(id){ return state.suppliers.find(s=>s.id===id); }
function getItem(id){ return state.items.find(i=>i.id===id); }
function itemLabel(i){ return i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item"; }
function poNumber(po){ return po.po_number || `PO-${String(po.id || "").slice(0,8)}`; }
function sameUnit(a,b){ return String(a||"").toLowerCase().trim() === String(b||"").toLowerCase().trim(); }
function rnNo(n){ return n.grn_number || n.receiving_number || `RN-${String(n.id || "").slice(0,8)}`; }

function lineTotal(l){
  const unit = l.unit || l.order_unit || "";
  const cost = l.cost_unit || "";
  return sameUnit(unit,cost) ? Number(l.ordered_qty||0) * Number(l.unit_price||0) : 0;
}
function lineTotalText(l){
  if(!sameUnit(l.unit||l.order_unit,l.cost_unit)) return "Pending receiving";
  return money(lineTotal(l));
}

function statusBadge(st){
  const s = st || "draft";
  const cls = s === "approved" ? "blue" : s === "draft" ? "gold" : s.includes("received") ? "green" : s === "closed" ? "red" : s === "cancelled" ? "red" : "gold";
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

async function loadPurchaseData(){
  await loadItemDeps();
  await loadItems();
  state.purchaseOrders = await safeSelect("purchase_orders","*", { eq:{ branch_id: state.currentBranchId }, order:"created_at", ascending:false }).catch(()=>[]);
  stockBalances = await safeSelect("stock_balances","*", { eq:{ branch_id: state.currentBranchId } }).catch(()=>[]);
  receivingNotes = await safeSelect("receiving_notes","*", { eq:{ branch_id: state.currentBranchId }, order:"created_at", ascending:false }).catch(()=>[]);
  receivingLines = await safeSelect("receiving_note_lines","*").catch(()=>[]);
}

export async function renderPurchaseOrders(){
  if(!isManager()) return $("content").innerHTML = showError("Staff users cannot access Purchase Orders.");
  const content = $("content");
  content.innerHTML = `<div class="card">Loading purchase orders...</div>`;
  try{
    await loadPurchaseData();
    content.innerHTML = `<div class="card">
      <div class="section-head">
        <h2>Purchase Orders</h2>
        <div class="toolbar">
          <select id="poStatusFilter"><option value="">All status</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="partially_received">Partially Received</option><option value="fully_received">Fully Received</option><option value="closed">Closed</option><option value="cancelled">Cancelled</option></select>
          <select id="poSupplierFilter"><option value="">All suppliers</option>${state.suppliers.map(s=>`<option value="${esc(s.id)}">${esc(supplierName(s))}</option>`).join("")}</select>
          <input id="poSearch" class="input" placeholder="Search PO...">
          <button class="btn gold" id="copyReorderDraftBtn">Suggested Reorder</button>
          <button class="btn" id="newPoBtn">+ New PO</button>
        </div>
      </div>
      <div id="poTable"></div>
    </div>`;
    $("poStatusFilter").value = poFilters.status;
    $("poSupplierFilter").value = poFilters.supplier_id;
    $("poSearch").value = poFilters.search;
    $("poStatusFilter").onchange = e=>{ poFilters.status=e.target.value; renderPoTable(); };
    $("poSupplierFilter").onchange = e=>{ poFilters.supplier_id=e.target.value; renderPoTable(); };
    $("poSearch").oninput = e=>{ poFilters.search=e.target.value; renderPoTable(); };
    $("newPoBtn").onclick = ()=>openPoModal();
    $("copyReorderDraftBtn").onclick = openSuggestedReorderModal;
    renderPoTable();
  }catch(e){ content.innerHTML = showError("Could not load Purchase Orders. " + e.message); }
}

function renderPoTable(){
  const q = poFilters.search.toLowerCase();
  const rows = state.purchaseOrders.filter(po=>{
    if(poFilters.status && po.status !== poFilters.status) return false;
    if(poFilters.supplier_id && po.supplier_id !== poFilters.supplier_id) return false;
    return JSON.stringify(po).toLowerCase().includes(q);
  });
  $("poTable").innerHTML = `<table><thead><tr><th>PO</th><th>PO Date</th><th>Supplier</th><th>Status</th><th>Delivery</th><th>PO Total</th><th>Received Total</th><th></th></tr></thead>
  <tbody>${rows.map(po=>`
    <tr>
      <td><b>${esc(poNumber(po))}</b><div class="muted">${esc(po.notes || "")}</div></td>
      <td>${esc(po.order_date || (po.created_at || "").slice(0,10))}</td>
      <td>${esc(supplierName(getSupplier(po.supplier_id)))}</td>
      <td>${statusBadge(po.status)}</td>
      <td>${po.delivery_asap ? "ASAP" : esc(po.expected_delivery_date || "")}</td>
      <td>${money(po.total_amount)}</td>
      <td>${money(receivedTotalForPo(po.id))}</td>
      <td><button class="btn secondary small view-po" data-id="${esc(po.id)}">Open</button></td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">No purchase orders yet.</td></tr>`}</tbody></table>`;
  document.querySelectorAll(".view-po").forEach(b=>b.onclick=()=>openPoModal(state.purchaseOrders.find(po=>po.id===b.dataset.id)));
}

async function loadPoLines(poId){
  return await safeSelect("purchase_order_lines","*", { eq:{ purchase_order_id: poId }, order:"sort_order" }).catch(()=>[]);
}
function relatedNotes(poId){ return receivingNotes.filter(n => (n.po_id || n.purchase_order_id) === poId); }
function relatedNoteIds(poId){ return new Set(relatedNotes(poId).map(n=>n.id)); }
function receivedQtyForLine(poId,lineId){
  const ids = relatedNoteIds(poId);
  return receivingLines.filter(l => ids.has(l.grn_id || l.receiving_note_id) && (l.po_line_id || l.purchase_order_line_id) === lineId).reduce((a,l)=>a+Number(l.accepted_qty||0),0);
}
function receivedValueForLine(poId,lineId){
  const ids = relatedNoteIds(poId);
  return receivingLines.filter(l => ids.has(l.grn_id || l.receiving_note_id) && (l.po_line_id || l.purchase_order_line_id) === lineId).reduce((a,l)=>{
    const total = l.line_total != null ? Number(l.line_total||0) : Number(l.accepted_qty||0) * Number(l.actual_unit_price || l.unit_price || 0);
    return a + total;
  },0);
}
function receivedTotalForPo(poId){ return relatedNotes(poId).reduce((a,n)=>a+Number(n.total_amount||0),0); }
function currentStockText(itemId) {
  const it = getItem(itemId);
  if (!it) return "";
  const b = stockBalances.find(x => x.item_id === itemId);
  const amount = b ? Number(b.qty_on_hand ?? b.current_qty ?? b.quantity ?? 0) : 0;
  if (amount <= 0) return `🔴 0 ${it.stock_unit || ""}`;
  if (it.reorder_level != null && Number(it.reorder_level) > 0 && amount <= Number(it.reorder_level)) return `🟠 ${qty(amount)} ${it.stock_unit || ""}`;
  return `🟢 ${qty(amount)} ${it.stock_unit || ""}`;
}

function blankLine(){ return { item_id:"", ordered_qty:1, unit:"", order_unit:"", cost_unit:"", unit_price:0, notes:"" }; }
function lineFromItem(item){
  const u = item.receiving_unit || item.purchase_package_type || item.stock_unit;
  return { item_id:item.id, ordered_qty:Number(item.reorder_qty||1), unit:u, order_unit:u, cost_unit:item.cost_unit||item.stock_unit, unit_price:Number(item.default_purchase_price||0), notes:"" };
}

async function openPoModal(po=null){
  const isEdit = !!po;
  const lines = isEdit ? await loadPoLines(po.id) : [blankLine()];
  const locked = po && !["draft", null, undefined, ""].includes(po.status);
  openModal(`<div class="modal-head"><h3>${isEdit ? "Purchase Order " + esc(poNumber(po)) : "New Purchase Order"}</h3><button class="btn secondary small" onclick="closeModal()">✕</button></div>
  <form id="poForm">
    <div class="modal-body">
      <div class="form-grid">
        <div><label>Supplier</label><select name="supplier_id" ${locked?"disabled":""} required>${state.suppliers.map(s=>`<option value="${esc(s.id)}" ${s.id===po?.supplier_id?"selected":""}>${esc(supplierName(s))}</option>`).join("")}</select></div>
        <div><label>Status</label><input class="input" value="${esc(po?.status || "draft")}" disabled></div>
        <div><label>Purchase Order Date</label><input name="order_date" type="date" class="input" value="${esc(po?.order_date || (po?.created_at || new Date().toISOString()).slice(0,10))}" ${locked?"disabled":""}></div>
        <div><label>Expected Delivery</label><input name="expected_delivery_date" type="date" class="input" value="${esc(po?.expected_delivery_date || "")}" ${locked?"disabled":""}></div>
        <div><label><input type="checkbox" name="delivery_asap" ${po?.delivery_asap ? "checked":""} ${locked?"disabled":""}> ASAP</label></div>
        <div class="full"><label>Notes to supplier</label><textarea name="notes" class="input" rows="2" ${locked?"disabled":""}>${esc(po?.notes || "")}</textarea></div>
      </div>
      ${isEdit ? summaryBlock(po) : ""}
      <div style="margin-top:18px" class="section-head"><h3 style="margin:0">Lines</h3>${locked ? "" : `<button type="button" class="btn secondary small" id="addPoLineBtn">+ Add Line</button>`}</div>
      <div id="poLinesBox"></div>
      ${isEdit ? receivingNotesBlock(po) : ""}
      <div style="margin-top:14px;text-align:right;font-weight:900;font-size:20px">PO Total: <span id="poTotal">$0.00</span></div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn secondary" onclick="closeModal()">Close</button>
      ${isEdit ? `<button type="button" class="btn secondary" id="copyPoTextBtn">Copy Text</button>` : ""}
      ${isEdit && (po.status || "draft")==="draft" ? `<button type="button" class="btn green" id="approvePoBtn">Approve</button>` : ""}
      ${isEdit && (po.status || "")==="partially_received" ? `<button type="button" class="btn red" id="closePoBtn">Close PO / Accept Received Only</button>` : ""}
      ${locked ? "" : `<button class="btn">${isEdit ? "Save Draft" : "Create Draft"}</button>`}
    </div>
  </form>`);

  const localLines = lines.length ? lines.map(x=>({...x, unit:x.unit||x.order_unit||"", order_unit:x.order_unit||x.unit||""})) : [blankLine()];

  function renderLines(){
    $("poLinesBox").innerHTML = `<table class="po-lines"><thead><tr><th>Item</th><th>Current Stock</th><th>Ordered</th><th>Received</th><th>Remaining</th><th>Unit</th><th>Cost Unit</th><th>Cost/Unit</th><th>PO Total</th><th>Received Value</th><th>Notes</th><th></th></tr></thead><tbody>
    ${localLines.map((l,idx)=>{
      const it=getItem(l.item_id);
      const unit = l.unit || l.order_unit || it?.receiving_unit || "";
      const cost = l.cost_unit || it?.cost_unit || "";
      const recQty = isEdit ? receivedQtyForLine(po.id,l.id) : 0;
      const remain = Math.max(0, Number(l.ordered_qty||0)-recQty);
      const recVal = isEdit ? receivedValueForLine(po.id,l.id) : 0;
      const display = {...l, unit, cost_unit:cost};
      return `<tr>
        <td><select data-idx="${idx}" class="po-item" ${locked?"disabled":""}><option value="">-- Select --</option>${state.items.map(i=>`<option value="${esc(i.id)}" ${i.id===l.item_id?"selected":""}>${esc(itemLabel(i))}</option>`).join("")}</select></td>
        <td class="muted">${it ? currentStockText(it.id) : ""}</td>
        <td><input type="number" step="0.001" class="input po-qty" data-idx="${idx}" value="${esc(l.ordered_qty ?? "")}" ${locked?"disabled":""}></td>
        <td>${qty(recQty)}</td>
        <td>${qty(remain)}</td>
        <td>${esc(unit)}</td>
        <td>${esc(cost)}</td>
        <td><input type="number" step="0.01" class="input po-price" data-idx="${idx}" value="${esc(l.unit_price ?? 0)}" ${locked?"disabled":""}></td>
        <td>${lineTotalText(display)}</td>
        <td>${money(recVal)}</td>
        <td><input class="input po-note" data-idx="${idx}" value="${esc(l.notes || "")}" ${locked?"disabled":""}></td>
        <td>${locked ? "" : `<button type="button" class="btn red small po-remove" data-idx="${idx}">×</button>`}</td>
      </tr>`;
    }).join("")}</tbody></table>`;
    const total = localLines.reduce((sum,l)=>sum+lineTotal({...l, unit:l.unit||l.order_unit}),0);
    $("poTotal").textContent = money(total);
    bindLineEvents();
  }

  function bindLineEvents(){
    document.querySelectorAll(".po-item").forEach(el=>el.onchange=e=>{ const idx=Number(e.target.dataset.idx); const it=getItem(e.target.value); localLines[idx]=it?lineFromItem(it):blankLine(); renderLines(); });
    document.querySelectorAll(".po-qty").forEach(el=>el.oninput=e=>{ localLines[Number(e.target.dataset.idx)].ordered_qty=Number(e.target.value||0); renderLines(); });
    document.querySelectorAll(".po-price").forEach(el=>el.oninput=e=>{ localLines[Number(e.target.dataset.idx)].unit_price=Number(e.target.value||0); renderLines(); });
    document.querySelectorAll(".po-note").forEach(el=>el.oninput=e=>{ localLines[Number(e.target.dataset.idx)].notes=e.target.value; });
    document.querySelectorAll(".po-remove").forEach(el=>el.onclick=e=>{ localLines.splice(Number(e.target.dataset.idx),1); if(!localLines.length)localLines.push(blankLine()); renderLines(); });
  }

  renderLines();
  if(!locked) $("addPoLineBtn").onclick = ()=>{ localLines.push(blankLine()); renderLines(); };
  if(isEdit) $("copyPoTextBtn").onclick = ()=>copyPoText(po, localLines);
  if(isEdit && (po.status || "draft")==="draft") $("approvePoBtn").onclick = async()=>approvePo(po.id);
  if(isEdit && (po.status || "")==="partially_received") $("closePoBtn").onclick = async()=>closePo(po.id);

  $("poForm").onsubmit = async(e)=>{
    e.preventDefault();
    if(locked) return;
    const fd = new FormData(e.target);
    const total = localLines.reduce((sum,l)=>sum+lineTotal({...l, unit:l.unit||l.order_unit}),0);
    const payload = { branch_id: state.currentBranchId, supplier_id: fd.get("supplier_id"), status: po?.status || "draft", order_date: fd.get("order_date") || new Date().toISOString().slice(0,10), expected_delivery_date: fd.get("expected_delivery_date") || null, delivery_asap: fd.get("delivery_asap") === "on", notes: fd.get("notes") || null, total_amount: total, updated_at: new Date().toISOString() };
    try{
      let saved;
      if(isEdit) saved = await updateRow("purchase_orders", po.id, payload);
      else { payload.created_by = state.user.id; payload.po_number = `PO-${Date.now().toString().slice(-8)}`; saved = await insertRow("purchase_orders", payload); }
      await deleteRows("purchase_order_lines", "purchase_order_id", saved.id);
      const clean = localLines.filter(l=>l.item_id).map((l,idx)=>{ const it=getItem(l.item_id); const orderUnit = l.unit || l.order_unit || it?.receiving_unit || it?.stock_unit; const costUnit = l.cost_unit || it?.cost_unit || it?.stock_unit; return { purchase_order_id:saved.id, item_id:l.item_id, ordered_qty:Number(l.ordered_qty||0), unit:orderUnit, order_unit:orderUnit, cost_unit:costUnit, unit_price:Number(l.unit_price||0), notes:l.notes||null, sort_order:idx }; });
      if(clean.length){ const { error } = await state.db.from("purchase_order_lines").insert(clean); if(error) throw error; }
      toast("Purchase order saved.", "ok"); closeModal(); renderPurchaseOrders();
    }catch(err){ toast("PO save failed: " + err.message, "error"); }
  };
}

function summaryBlock(po){
  const actual = receivedTotalForPo(po.id);
  return `<div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:16px">
    <div class="card"><div class="stat-title">PO Order Total</div><div><b>${money(po.total_amount)}</b></div></div>
    <div class="card"><div class="stat-title">Actual Received Total</div><div><b>${money(actual)}</b></div></div>
    <div class="card"><div class="stat-title">Outstanding Value</div><div><b>${money(Math.max(0, Number(po.total_amount||0)-actual))}</b></div></div>
  </div>`;
}

function receivingNotesBlock(po){
  const notes = relatedNotes(po.id);
  return `<div class="card" style="margin-top:16px"><div class="section-head"><h3 style="margin:0">Receiving Notes</h3></div><table><thead><tr><th>RN</th><th>Date</th><th>Total</th></tr></thead><tbody>
    ${notes.map(n=>`<tr><td>${esc(rnNo(n))}</td><td>${esc((n.received_date||n.received_at||n.created_at||"").slice(0,10))}</td><td>${money(n.total_amount)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No receiving notes yet.</td></tr>`}
  </tbody></table></div>`;
}

async function approvePo(id){
  try{ const { error } = await state.db.from("purchase_orders").update({ status:"approved", approved_at:new Date().toISOString(), approved_by:state.user.id }).eq("id", id); if(error) throw error; toast("Purchase order approved.", "ok"); closeModal(); renderPurchaseOrders(); }
  catch(e){ toast(e.message, "error"); }
}
async function closePo(id){
  try{ const { error } = await state.db.from("purchase_orders").update({ status:"closed", updated_at:new Date().toISOString() }).eq("id", id); if(error) throw error; toast("Purchase order closed.", "ok"); closeModal(); renderPurchaseOrders(); }
  catch(e){ toast(e.message, "error"); }
}
function copyPoText(po, lines){
  const msg = [`Purchase Order: ${poNumber(po)}`, `Supplier: ${supplierName(getSupplier(po.supplier_id))}`, `PO Date: ${po.order_date || (po.created_at || "").slice(0,10)}`, `Delivery: ${po.delivery_asap ? "ASAP" : po.expected_delivery_date || "-"}`, "", ...lines.filter(l=>l.item_id).map((l,i)=>`${i+1}. ${itemLabel(getItem(l.item_id))} - ${qty(l.ordered_qty)} ${l.unit || l.order_unit || getItem(l.item_id)?.receiving_unit || ""}`), "", `Actual Received Total: ${money(receivedTotalForPo(po.id))}`, po.notes ? `Notes: ${po.notes}` : ""].join("\n");
  navigator.clipboard.writeText(msg); toast("PO text copied.", "ok");
}
function openSuggestedReorderModal(){
  const rows = state.items.filter(i => Number(i.reorder_qty||0) > 0);
  openModal(`<div class="modal-head"><h3>Suggested Reorder Draft</h3><button class="btn secondary small" onclick="closeModal()">✕</button></div><div class="modal-body"><p class="muted">This lists items with Reorder Qty. Later it will compare real branch stock to Reorder Level.</p><table><thead><tr><th>Item</th><th>Supplier</th><th>Reorder Qty</th><th>Stock Unit</th></tr></thead><tbody>${rows.map(i=>`<tr><td>${esc(itemLabel(i))}</td><td>${esc(supplierName(getSupplier(i.primary_supplier_id)))}</td><td>${qty(i.reorder_qty)}</td><td>${esc(i.stock_unit)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No reorder quantities set.</td></tr>`}</tbody></table></div><div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>`);
}
