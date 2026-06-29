import { state } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow } from "../services/db.js";
import { loadItems, loadItemDeps } from "./items.js";
import { supplierName } from "./suppliers.js";

let filters = { supplier_id: "", search: "" };
let poList = [];
let items = [];
let suppliers = [];
let notes = [];
let noteLines = [];

const sameUnit = (a,b) => String(a||"").toLowerCase() === String(b||"").toLowerCase();
const item = id => items.find(i => i.id === id);
const sup = id => suppliers.find(s => s.id === id);
const poNo = po => po.po_number || `PO-${String(po.id || "").slice(0,8)}`;
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";
const rnNo = n => n.receiving_number || `RN-${String(n.id || "").slice(0,8)}`;

async function loadAll(){
  await loadItemDeps();
  await loadItems();
  items = state.items || [];
  suppliers = state.suppliers || [];
  poList = await safeSelect("purchase_orders","*", { eq:{ branch_id:state.currentBranchId }, order:"created_at", ascending:false }).catch(()=>[]);
  poList = poList.filter(p => ["approved","partially_received"].includes(p.status || ""));
  notes = await safeSelect("receiving_notes","*", { eq:{ branch_id:state.currentBranchId }, order:"created_at", ascending:false }).catch(()=>[]);
  noteLines = await safeSelect("receiving_note_lines","*", {}).catch(()=>[]);
}

export async function renderReceiving(){
  const c = $("content");
  c.innerHTML = '<div class="card">Loading receiving...</div>';
  try{
    await loadAll();
    c.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Receiving</h2>
          <div class="toolbar">
            <select id="recSupplier"><option value="">All suppliers</option>${suppliers.map(s=>`<option value="${esc(s.id)}">${esc(supplierName(s))}</option>`).join("")}</select>
            <input id="recSearch" class="input" placeholder="Search PO...">
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Approved and partially received purchase orders for this branch.</div>
        <div id="receivingTable"></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Recent Receiving Notes</h2></div>
        <div id="recentReceiving"></div>
      </div>`;
    $("recSupplier").value = filters.supplier_id;
    $("recSearch").value = filters.search;
    $("recSupplier").onchange = e => { filters.supplier_id = e.target.value; drawTables(); };
    $("recSearch").oninput = e => { filters.search = e.target.value; drawTables(); };
    drawTables();
  }catch(e){ c.innerHTML = showError(e.message); }
}

function receivedBefore(poId, line){
  const noteIds = new Set(notes.filter(n => n.purchase_order_id === poId).map(n => n.id));
  return noteLines.filter(l => noteIds.has(l.receiving_note_id) && l.purchase_order_line_id === line.id)
    .reduce((a,l)=>a + Number(l.accepted_qty || l.received_qty || 0),0);
}

function drawTables(){
  const q = filters.search.toLowerCase();
  const rows = poList.filter(po => (!filters.supplier_id || po.supplier_id === filters.supplier_id) && JSON.stringify(po).toLowerCase().includes(q));
  $("receivingTable").innerHTML = `
    <table><thead><tr><th>PO</th><th>PO Date</th><th>Supplier</th><th>Status</th><th>Expected</th><th>Total</th><th></th></tr></thead>
    <tbody>${rows.map(po=>`
      <tr>
        <td><b>${esc(poNo(po))}</b><div class="muted">${esc(po.notes || "")}</div></td>
        <td>${esc(po.order_date || (po.created_at || "").slice(0,10))}</td>
        <td>${esc(supplierName(sup(po.supplier_id)))}</td>
        <td><span class="badge ${po.status === "approved" ? "blue" : "green"}">${esc(po.status)}</span></td>
        <td>${po.delivery_asap ? "ASAP" : esc(po.expected_delivery_date || "")}</td>
        <td>${money(po.total_amount)}</td>
        <td><button class="btn small open-rec" data-id="${esc(po.id)}">Receive</button></td>
      </tr>`).join("") || '<tr><td colspan="7" class="muted">No approved purchase orders ready for receiving.</td></tr>'}</tbody></table>`;
  document.querySelectorAll(".open-rec").forEach(b=> b.onclick = () => openReceiving(poList.find(p=>p.id === b.dataset.id)));
  drawRecent();
}

function drawRecent(){
  const recent = notes.slice(0,10);
  $("recentReceiving").innerHTML = `
    <table><thead><tr><th>RN</th><th>Supplier</th><th>Date</th><th>Total</th><th></th></tr></thead>
    <tbody>${recent.map(n=>`
      <tr>
        <td><b>${esc(rnNo(n))}</b></td>
        <td>${esc(supplierName(sup(n.supplier_id)))}</td>
        <td>${esc((n.received_at || n.created_at || "").slice(0,10))}</td>
        <td>${money(n.total_amount)}</td>
        <td><button class="btn secondary small rn-copy" data-id="${esc(n.id)}">Copy</button></td>
      </tr>`).join("") || '<tr><td colspan="5" class="muted">No receiving notes yet.</td></tr>'}</tbody></table>`;
  document.querySelectorAll(".rn-copy").forEach(b=> b.onclick = () => copyReceivingNote(notes.find(n=>n.id === b.dataset.id)));
}

async function openReceiving(po){
  const poLines = await safeSelect("purchase_order_lines","*", { eq:{ purchase_order_id:po.id }, order:"sort_order" }).catch(()=>[]);
  const local = poLines.map(l=>{
    const it = item(l.item_id);
    const unit = l.order_unit || l.unit || it?.receiving_unit || it?.stock_unit;
    const cost_unit = l.cost_unit || it?.cost_unit || it?.stock_unit;
    const before = receivedBefore(po.id, l);
    const ordered = Number(l.ordered_qty || 0);
    return {
      purchase_order_line_id:l.id, item_id:l.item_id, item_name:itemLabel(it),
      ordered_qty:ordered, received_before_qty:before, remaining_qty:Math.max(0, ordered-before),
      receive_now_qty:0, accepted_qty:0, rejected_qty:0, reject_reason:"",
      actual_cost_qty: sameUnit(unit,cost_unit) ? 0 : null,
      unit, stock_unit:it?.stock_unit || unit, cost_unit, unit_price:Number(l.unit_price || 0), notes:""
    };
  });

  openModal(`
    <div class="modal-head"><h3>Receive ${esc(poNo(po))}</h3><button class="btn secondary small" onclick="closeModal()">✕</button></div>
    <form id="receivingForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Supplier</label><input class="input" value="${esc(supplierName(sup(po.supplier_id)))}" disabled></div>
          <div><label>Receiving Date</label><input name="received_at" type="date" class="input" value="${new Date().toISOString().slice(0,10)}"></div>
          <div class="full"><label>Receiving Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
        <div style="margin-top:16px" id="recLinesBox"></div>
        <div style="text-align:right;font-weight:900;font-size:20px;margin-top:14px">Receiving Total: <span id="recTotal">$0.00</span></div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn green">Save Receiving</button></div>
    </form>`);

  function calcLine(l){ return sameUnit(l.unit,l.cost_unit) ? Number(l.accepted_qty||0)*Number(l.unit_price||0) : Number(l.actual_cost_qty||0)*Number(l.unit_price||0); }

  function draw(){
    $("recLinesBox").innerHTML = `
      <table><thead><tr><th>Item</th><th>Ordered</th><th>Received Before</th><th>Receive Now</th><th>Accepted</th><th>Rejected</th><th>Cost Qty</th><th>Total</th><th>Reason</th></tr></thead>
      <tbody>${local.map((l,i)=>`
        <tr>
          <td><b>${esc(l.item_name)}</b><div class="muted">${esc(l.unit)} / cost ${esc(l.cost_unit)}</div></td>
          <td>${qty(l.ordered_qty)} ${esc(l.unit)}</td>
          <td>${qty(l.received_before_qty)} ${esc(l.unit)}</td>
          <td><input type="number" step="0.001" class="input rec-now" data-i="${i}" value="${esc(l.receive_now_qty)}"></td>
          <td><input type="number" step="0.001" class="input rec-accepted" data-i="${i}" value="${esc(l.accepted_qty)}"></td>
          <td><input type="number" step="0.001" class="input rec-rejected" data-i="${i}" value="${esc(l.rejected_qty)}"></td>
          <td>${sameUnit(l.unit,l.cost_unit) ? '<span class="muted">Auto</span>' : `<input type="number" step="0.001" class="input rec-costqty" data-i="${i}" value="${esc(l.actual_cost_qty ?? "")}" placeholder="${esc(l.cost_unit)}">`}</td>
          <td>${money(calcLine(l))}</td>
          <td><input class="input rec-reason" data-i="${i}" value="${esc(l.reject_reason || "")}" placeholder="Reject reason"></td>
        </tr>`).join("")}</tbody></table>`;
    $("recTotal").textContent = money(local.reduce((a,l)=>a+calcLine(l),0));
    bind();
  }

  function bind(){
    document.querySelectorAll(".rec-now").forEach(e=>e.oninput=()=>{ const l=local[+e.dataset.i]; l.receive_now_qty=Number(e.value||0); l.accepted_qty=Math.max(0, Number(l.receive_now_qty||0)-Number(l.rejected_qty||0)); draw(); });
    document.querySelectorAll(".rec-accepted").forEach(e=>e.oninput=()=>{ local[+e.dataset.i].accepted_qty=Number(e.value||0); draw(); });
    document.querySelectorAll(".rec-rejected").forEach(e=>e.oninput=()=>{ const l=local[+e.dataset.i]; l.rejected_qty=Number(e.value||0); l.accepted_qty=Math.max(0, Number(l.receive_now_qty||0)-Number(l.rejected_qty||0)); draw(); });
    document.querySelectorAll(".rec-costqty").forEach(e=>e.oninput=()=>{ local[+e.dataset.i].actual_cost_qty=Number(e.value||0); draw(); });
    document.querySelectorAll(".rec-reason").forEach(e=>e.oninput=()=>{ local[+e.dataset.i].reject_reason=e.value; });
  }
  draw();

  $("receivingForm").onsubmit = async e=>{
    e.preventDefault();
    const f = new FormData(e.target);
    const active = local.filter(l => Number(l.receive_now_qty||0)>0 || Number(l.accepted_qty||0)>0 || Number(l.rejected_qty||0)>0);
    if(!active.length) return toast("Enter at least one received quantity.", "error");

    try{
      const total = active.reduce((a,l)=>a+calcLine(l),0);
      const note = await insertRow("receiving_notes", {
        receiving_number:`RN-${Date.now().toString().slice(-8)}`,
        purchase_order_id:po.id, branch_id:state.currentBranchId, supplier_id:po.supplier_id,
        received_at:f.get("received_at"), notes:f.get("notes")||null, total_amount:total,
        status:"saved", created_by:state.user.id
      });

      const rows = active.map((l,i)=>({
        receiving_note_id:note.id, purchase_order_id:po.id, purchase_order_line_id:l.purchase_order_line_id,
        item_id:l.item_id, received_qty:Number(l.receive_now_qty||0), accepted_qty:Number(l.accepted_qty||0),
        rejected_qty:Number(l.rejected_qty||0), reject_reason:l.reject_reason||null,
        order_unit:l.unit, stock_unit:l.stock_unit, cost_unit:l.cost_unit,
        cost_qty:sameUnit(l.unit,l.cost_unit)?Number(l.accepted_qty||0):Number(l.actual_cost_qty||0),
        unit_price:Number(l.unit_price||0), notes:l.notes||null, sort_order:i
      }));

      const r = await state.db.from("receiving_note_lines").insert(rows);
      if(r.error) throw r.error;

      for(const l of active){
        if(Number(l.accepted_qty||0)>0){
          await addStockMovement(note, po, l);
          await addToStockBalance(l.item_id, Number(l.accepted_qty||0));
        }
      }

      await updatePoStatus(po.id);
      toast("Receiving saved.", "ok");
      closeModal();
      renderReceiving();
    }catch(err){ toast("Receiving failed: " + err.message, "error"); }
  };
}

async function addStockMovement(note, po, l){
  const payload = {
    branch_id:state.currentBranchId, item_id:l.item_id, movement_type:"receiving",
    qty:Number(l.accepted_qty||0), quantity:Number(l.accepted_qty||0), unit:l.stock_unit,
    reference_id:note.id, reference_type:"receiving", notes:`Receiving ${rnNo(note)} from ${poNo(po)}`,
    created_by:state.user.id
  };
  const r = await state.db.from("stock_movements").insert(payload);
  if(r.error) throw r.error;
}

async function addToStockBalance(itemId, addQty){
  const res = await state.db.from("stock_balances").select("*").eq("branch_id",state.currentBranchId).eq("item_id",itemId).maybeSingle();
  if(res.error && res.error.code !== "PGRST116") throw res.error;
  const row = res.data;
  if(!row){
    const r = await state.db.from("stock_balances").insert({ branch_id:state.currentBranchId, item_id:itemId, qty_on_hand:addQty, current_qty:addQty, quantity:addQty, updated_at:new Date().toISOString() });
    if(r.error) throw r.error;
    return;
  }
  const current = Number(row.qty_on_hand ?? row.current_qty ?? row.quantity ?? 0);
  const newQty = current + addQty;
  const payload = { updated_at:new Date().toISOString() };
  if("qty_on_hand" in row) payload.qty_on_hand = newQty;
  if("current_qty" in row) payload.current_qty = newQty;
  if("quantity" in row) payload.quantity = newQty;
  const r = await state.db.from("stock_balances").update(payload).eq("id",row.id);
  if(r.error) throw r.error;
}

async function updatePoStatus(poId){
  const poLines = await safeSelect("purchase_order_lines","*", { eq:{purchase_order_id:poId} }).catch(()=>[]);
  const rn = await safeSelect("receiving_notes","*", { eq:{purchase_order_id:poId} }).catch(()=>[]);
  const rnIds = new Set(rn.map(x=>x.id));
  const rnl = await safeSelect("receiving_note_lines","*", {}).catch(()=>[]);
  const related = rnl.filter(x=>rnIds.has(x.receiving_note_id));
  let allDone = true, anyReceived = false;
  for(const l of poLines){
    const ordered = Number(l.ordered_qty||0);
    const received = related.filter(x=>x.purchase_order_line_id === l.id).reduce((a,x)=>a+Number(x.accepted_qty||x.received_qty||0),0);
    if(received > 0) anyReceived = true;
    if(received < ordered) allDone = false;
  }
  const status = allDone ? "fully_received" : anyReceived ? "partially_received" : "approved";
  const r = await state.db.from("purchase_orders").update({ status, updated_at:new Date().toISOString() }).eq("id",poId);
  if(r.error) throw r.error;
}

function copyReceivingNote(note){
  const lines = noteLines.filter(l=>l.receiving_note_id === note.id);
  const msg = [
    `Receiving Note: ${rnNo(note)}`,
    `Supplier: ${supplierName(sup(note.supplier_id))}`,
    `Date: ${(note.received_at || note.created_at || "").slice(0,10)}`,
    "",
    ...lines.map((l,i)=>`${i+1}. ${itemLabel(item(l.item_id))} - Received ${qty(l.received_qty)} ${l.order_unit || l.stock_unit || ""}, Accepted ${qty(l.accepted_qty)}, Rejected ${qty(l.rejected_qty || 0)}${l.reject_reason ? " - " + l.reject_reason : ""}`),
    "",
    `Total: ${money(note.total_amount)}`
  ].join("\\n");
  navigator.clipboard.writeText(msg);
  toast("Receiving note copied.", "ok");
}
