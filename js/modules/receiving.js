import { state } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow } from "../services/db.js";
import { loadItems, loadItemDeps } from "./items.js";
import { supplierName } from "./suppliers.js";

let filters = { supplier_id: "", search: "" };
let poList = [];
let items = [];
let suppliers = [];
let receivingNotes = [];
let receivingLines = [];

const sameUnit = (a, b) => String(a || "").toLowerCase().trim() === String(b || "").toLowerCase().trim();
const item = id => items.find(i => i.id === id);
const supplier = id => suppliers.find(s => s.id === id);
const poNo = po => po?.po_number || `PO-${String(po?.id || "").slice(0, 8)}`;
const rnNo = rn => rn?.grn_number || rn?.receiving_number || `RN-${String(rn?.id || "").slice(0, 8)}`;
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";

function statusBadge(status) {
  const s = status || "approved";
  const cls = s === "approved" ? "blue" : s === "partially_received" ? "gold" : s === "fully_received" ? "green" : "gold";
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

function lineTotal(line) {
  if (sameUnit(line.unit, line.cost_unit)) {
    return Number(line.accepted_qty || 0) * Number(line.unit_price || 0);
  }
  return Number(line.actual_cost_qty || 0) * Number(line.unit_price || 0);
}

async function loadAll() {
  await loadItemDeps();
  await loadItems();
  items = state.items || [];
  suppliers = state.suppliers || [];

  poList = await safeSelect("purchase_orders", "*", {
    eq: { branch_id: state.currentBranchId },
    order: "created_at",
    ascending: false
  }).catch(() => []);

  poList = poList.filter(po => ["approved", "partially_received"].includes(po.status || ""));

  receivingNotes = await safeSelect("receiving_notes", "*", {
    eq: { branch_id: state.currentBranchId },
    order: "created_at",
    ascending: false
  }).catch(() => []);

  receivingLines = await safeSelect("receiving_note_lines", "*").catch(() => []);
}

export async function renderReceiving() {
  const content = $("content");
  content.innerHTML = '<div class="card">Loading receiving...</div>';

  try {
    await loadAll();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Receiving</h2>
          <div class="toolbar">
            <select id="recSupplier">
              <option value="">All suppliers</option>
              ${suppliers.map(s => `<option value="${esc(s.id)}">${esc(supplierName(s))}</option>`).join("")}
            </select>
            <input id="recSearch" class="input" placeholder="Search PO...">
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Shows approved and partially received purchase orders for this branch.</div>
        <div id="receivingTable"></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Recent Receiving Notes</h2></div>
        <div id="recentReceiving"></div>
      </div>
    `;

    $("recSupplier").value = filters.supplier_id;
    $("recSearch").value = filters.search;
    $("recSupplier").onchange = e => { filters.supplier_id = e.target.value; renderTables(); };
    $("recSearch").oninput = e => { filters.search = e.target.value; renderTables(); };
    renderTables();
  } catch (e) {
    content.innerHTML = showError(e.message);
  }
}

function renderTables() {
  const q = filters.search.toLowerCase();
  const rows = poList.filter(po => {
    if (filters.supplier_id && po.supplier_id !== filters.supplier_id) return false;
    return JSON.stringify(po).toLowerCase().includes(q);
  });

  $("receivingTable").innerHTML = `
    <table>
      <thead><tr><th>PO</th><th>PO Date</th><th>Supplier</th><th>Status</th><th>Expected</th><th>Total</th><th></th></tr></thead>
      <tbody>
        ${rows.map(po => `
          <tr>
            <td><b>${esc(poNo(po))}</b><div class="muted">${esc(po.notes || "")}</div></td>
            <td>${esc(po.order_date || (po.created_at || "").slice(0, 10))}</td>
            <td>${esc(supplierName(supplier(po.supplier_id)))}</td>
            <td>${statusBadge(po.status)}</td>
            <td>${po.delivery_asap ? "ASAP" : esc(po.expected_delivery_date || "")}</td>
            <td>${money(po.total_amount)}</td>
            <td><button class="btn small receive-po" data-id="${esc(po.id)}">Receive</button></td>
          </tr>`).join("") || '<tr><td colspan="7" class="muted">No approved purchase orders ready for receiving.</td></tr>'}
      </tbody>
    </table>`;

  document.querySelectorAll(".receive-po").forEach(btn => {
    btn.onclick = () => openReceivingModal(poList.find(po => po.id === btn.dataset.id));
  });

  renderRecentNotes();
}

function renderRecentNotes() {
  const recent = receivingNotes.slice(0, 10);
  $("recentReceiving").innerHTML = `
    <table>
      <thead><tr><th>RN</th><th>PO</th><th>Supplier</th><th>Date</th><th>Total</th><th></th></tr></thead>
      <tbody>
        ${recent.map(rn => {
          const po = poList.find(p => p.id === (rn.po_id || rn.purchase_order_id)) || {};
          return `
            <tr>
              <td><b>${esc(rnNo(rn))}</b></td>
              <td>${esc(poNo(po))}</td>
              <td>${esc(supplierName(supplier(rn.supplier_id || po.supplier_id)))}</td>
              <td>${esc((rn.received_date || rn.received_at || rn.created_at || "").slice(0, 10))}</td>
              <td>${money(rn.total_amount)}</td>
              <td>
                <button class="btn secondary small open-rn" data-id="${esc(rn.id)}">Open</button>
                <button class="btn secondary small copy-rn" data-id="${esc(rn.id)}">Copy</button>
              </td>
            </tr>`;
        }).join("") || '<tr><td colspan="6" class="muted">No receiving notes yet.</td></tr>'}
      </tbody>
    </table>`;

  document.querySelectorAll(".copy-rn").forEach(btn => {
    btn.onclick = () => copyReceivingNote(receivingNotes.find(rn => rn.id === btn.dataset.id));
  });
  document.querySelectorAll(".open-rn").forEach(btn => {
    btn.onclick = () => openReceivingNote(receivingNotes.find(rn => rn.id === btn.dataset.id));
  });
}

async function getPoLines(poId) {
  return await safeSelect("purchase_order_lines", "*", {
    eq: { purchase_order_id: poId },
    order: "sort_order"
  }).catch(() => []);
}

function receivedBefore(poId, poLineId) {
  const relatedNoteIds = new Set(
    receivingNotes.filter(n => (n.po_id || n.purchase_order_id) === poId).map(n => n.id)
  );
  return receivingLines
    .filter(l => relatedNoteIds.has(l.grn_id || l.receiving_note_id) && (l.po_line_id || l.purchase_order_line_id) === poLineId)
    .reduce((sum, l) => sum + Number(l.accepted_qty || 0), 0);
}

async function openReceivingModal(po) {
  if (!po) return toast("PO not found.", "error");

  const poLines = await getPoLines(po.id);
  const local = poLines.map(line => {
    const it = item(line.item_id);
    const unit = line.order_unit || line.unit || it?.receiving_unit || it?.stock_unit || "";
    const costUnit = line.cost_unit || it?.cost_unit || it?.stock_unit || unit;
    const alreadyReceived = receivedBefore(po.id, line.id);
    const orderedQty = Number(line.ordered_qty || 0);
    return {
      po_line_id: line.id,
      item_id: line.item_id,
      item_name: itemLabel(it),
      ordered_qty: orderedQty,
      received_before_qty: alreadyReceived,
      remaining_qty: Math.max(0, orderedQty - alreadyReceived),
      delivered_qty: 0,
      accepted_qty: 0,
      rejected_qty: 0,
      unit,
      stock_unit: it?.stock_unit || unit,
      cost_unit: costUnit,
      actual_cost_qty: sameUnit(unit, costUnit) ? null : 0,
      unit_price: Number(line.unit_price || 0),
      reject_reason: "",
      notes: ""
    };
  });

  openModal(`
    <div class="modal-head">
      <h3>Receive ${esc(poNo(po))}</h3>
      <button class="btn secondary small" onclick="closeModal()">✕</button>
    </div>
    <form id="receivingForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Supplier</label><input class="input" value="${esc(supplierName(supplier(po.supplier_id)))}" disabled></div>
          <div><label>Receiving Date</label><input name="received_date" type="date" class="input" value="${new Date().toISOString().slice(0,10)}"></div>
          <div class="full"><label>Receiving Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
        <div style="margin-top:16px" id="receivingLinesBox"></div>
        <div style="text-align:right;font-weight:900;font-size:20px;margin-top:14px">Receiving Total: <span id="receivingTotal">$0.00</span></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn green">Save Receiving</button>
      </div>
    </form>`);

  function calculateTotal() {
    return local.reduce((sum, line) => sum + lineTotal(line), 0);
  }

  function drawLines() {
    const anyCostQty = local.some(line => !sameUnit(line.unit, line.cost_unit));
    $("receivingLinesBox").innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Item</th><th>Ordered</th><th>Received Before</th>
            <th>Delivered Now</th><th>Accepted</th><th>Rejected</th>
            ${anyCostQty ? "<th>Billing Qty</th>" : ""}
            <th>Total</th><th>Reject Reason</th>
          </tr>
        </thead>
        <tbody>
          ${local.map((line, index) => {
            const needsBilling = !sameUnit(line.unit, line.cost_unit);
            return `
              <tr data-row="${index}">
                <td><b>${esc(line.item_name)}</b><div class="muted">Receive in ${esc(line.unit)}${needsBilling ? ` / bill by ${esc(line.cost_unit)}` : ""}</div></td>
                <td>${qty(line.ordered_qty)} ${esc(line.unit)}</td>
                <td>${qty(line.received_before_qty)} ${esc(line.unit)}</td>
                <td><input type="number" step="0.001" class="input delivered-input" data-index="${index}" value="${esc(line.delivered_qty)}" placeholder="${esc(line.unit)}"></td>
                <td><input type="number" step="0.001" class="input accepted-input" data-index="${index}" value="${esc(line.accepted_qty)}" placeholder="${esc(line.unit)}"></td>
                <td><input type="number" step="0.001" class="input rejected-input" data-index="${index}" value="${esc(line.rejected_qty)}" placeholder="${esc(line.unit)}"></td>
                ${anyCostQty ? `<td>${needsBilling ? `<input type="number" step="0.001" class="input costqty-input" data-index="${index}" value="${esc(line.actual_cost_qty ?? "")}" placeholder="Enter ${esc(line.cost_unit)}">` : '<span class="muted">Auto</span>'}</td>` : ""}
                <td class="line-total">${money(lineTotal(line))}</td>
                <td><input class="input reason-input" data-index="${index}" value="${esc(line.reject_reason || "")}" placeholder="Reason"></td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>`;
    $("receivingTotal").textContent = money(calculateTotal());
    bindLineInputs();
  }

  function updateTotalsOnly() {
    local.forEach((line, index) => {
      const row = document.querySelector(`tr[data-row="${index}"] .line-total`);
      if (row) row.textContent = money(lineTotal(line));
    });
    $("receivingTotal").textContent = money(calculateTotal());
  }

  function bindLineInputs() {
    document.querySelectorAll(".delivered-input").forEach(input => {
      input.oninput = () => {
        const line = local[Number(input.dataset.index)];
        line.delivered_qty = Number(input.value || 0);
        line.accepted_qty = Math.max(0, Number(line.delivered_qty || 0) - Number(line.rejected_qty || 0));
        const acceptedInput = document.querySelector(`.accepted-input[data-index="${input.dataset.index}"]`);
        if (acceptedInput) acceptedInput.value = line.accepted_qty;
        updateTotalsOnly();
      };
    });
    document.querySelectorAll(".accepted-input").forEach(input => {
      input.oninput = () => { local[Number(input.dataset.index)].accepted_qty = Number(input.value || 0); updateTotalsOnly(); };
    });
    document.querySelectorAll(".rejected-input").forEach(input => {
      input.oninput = () => {
        const line = local[Number(input.dataset.index)];
        line.rejected_qty = Number(input.value || 0);
        line.accepted_qty = Math.max(0, Number(line.delivered_qty || 0) - Number(line.rejected_qty || 0));
        const acceptedInput = document.querySelector(`.accepted-input[data-index="${input.dataset.index}"]`);
        if (acceptedInput) acceptedInput.value = line.accepted_qty;
        updateTotalsOnly();
      };
    });
    document.querySelectorAll(".costqty-input").forEach(input => {
      input.oninput = () => { local[Number(input.dataset.index)].actual_cost_qty = Number(input.value || 0); updateTotalsOnly(); };
    });
    document.querySelectorAll(".reason-input").forEach(input => {
      input.oninput = () => { local[Number(input.dataset.index)].reject_reason = input.value; };
    });
  }

  drawLines();

  $("receivingForm").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const activeLines = local.filter(line => Number(line.delivered_qty || 0) > 0 || Number(line.accepted_qty || 0) > 0 || Number(line.rejected_qty || 0) > 0);
    if (!activeLines.length) return toast("Enter at least one delivered quantity.", "error");

    try {
      const total = calculateTotal();
      const grnNumber = `RN-${Date.now().toString().slice(-8)}`;
      const note = await insertRow("receiving_notes", {
        grn_number: grnNumber,
        receiving_number: grnNumber,
        branch_id: state.currentBranchId,
        supplier_id: po.supplier_id,
        po_id: po.id,
        purchase_order_id: po.id,
        received_date: form.get("received_date"),
        received_at: form.get("received_date"),
        notes: form.get("notes") || null,
        total_amount: total,
        status: "saved",
        created_by: state.user.id
      });

      const lineRows = activeLines.map((line, index) => ({
        grn_id: note.id,
        receiving_note_id: note.id,
        po_line_id: line.po_line_id,
        purchase_order_line_id: line.po_line_id,
        purchase_order_id: po.id,
        item_id: line.item_id,
        ordered_qty: Number(line.ordered_qty || 0),
        delivered_qty: Number(line.delivered_qty || 0),
        received_qty: Number(line.delivered_qty || 0),
        accepted_qty: Number(line.accepted_qty || 0),
        rejected_qty: Number(line.rejected_qty || 0),
        receive_unit: line.unit,
        order_unit: line.unit,
        stock_unit: line.stock_unit,
        cost_unit: line.cost_unit,
        secondary_qty: sameUnit(line.unit, line.cost_unit) ? null : Number(line.actual_cost_qty || 0),
        secondary_unit: sameUnit(line.unit, line.cost_unit) ? null : line.cost_unit,
        cost_qty: sameUnit(line.unit, line.cost_unit) ? Number(line.accepted_qty || 0) : Number(line.actual_cost_qty || 0),
        actual_unit_price: Number(line.unit_price || 0),
        unit_price: Number(line.unit_price || 0),
        rejection_reason: line.reject_reason || null,
        reject_reason: line.reject_reason || null,
        notes: line.notes || null,
        sort_order: index
      }));

      const lineInsert = await state.db.from("receiving_note_lines").insert(lineRows);
      if (lineInsert.error) throw lineInsert.error;

      for (const line of activeLines) {
        if (Number(line.accepted_qty || 0) > 0) await addStockMovement(note, po, line);
      }

      await updatePoStatus(po.id);
      toast("Receiving saved.", "ok");
      closeModal();
      renderReceiving();
    } catch (error) {
      toast("Receiving failed: " + error.message, "error");
    }
  };
}

async function addStockMovement(note, po, line) {
  const amount = Number(line.accepted_qty || 0);
  const payload = {
    branch_id: state.currentBranchId,
    item_id: line.item_id,
    movement_type: "RECEIVING",
    qty_change: amount,
    qty: amount,
    quantity: amount,
    stock_unit: line.stock_unit,
    unit: line.stock_unit,
    reference_id: note.id,
    reference_type: "receiving",
    notes: `Receiving ${rnNo(note)} from ${poNo(po)}`,
    created_by: state.user.id
  };
  const result = await state.db.from("stock_movements").insert(payload);
  if (result.error) throw result.error;
}

async function updatePoStatus(poId) {
  const poLines = await safeSelect("purchase_order_lines", "*", { eq: { purchase_order_id: poId } }).catch(() => []);
  const notesForPo = await safeSelect("receiving_notes", "*", { eq: { po_id: poId } }).catch(() => []);
  const noteIds = new Set(notesForPo.map(note => note.id));
  const allLines = await safeSelect("receiving_note_lines", "*").catch(() => []);
  const relatedLines = allLines.filter(line => noteIds.has(line.grn_id || line.receiving_note_id));

  let anyReceived = false;
  let allDone = true;

  for (const poLine of poLines) {
    const ordered = Number(poLine.ordered_qty || 0);
    const received = relatedLines.filter(line => (line.po_line_id || line.purchase_order_line_id) === poLine.id).reduce((sum, line) => sum + Number(line.accepted_qty || 0), 0);
    if (received > 0) anyReceived = true;
    if (received < ordered) allDone = false;
  }

  const status = allDone ? "fully_received" : anyReceived ? "partially_received" : "approved";
  const result = await state.db.from("purchase_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", poId);
  if (result.error) throw result.error;
}

function openReceivingNote(note) {
  if (!note) return;
  const lines = receivingLines.filter(line => (line.grn_id || line.receiving_note_id) === note.id);
  openModal(`
    <div class="modal-head"><h3>Receiving Note ${esc(rnNo(note))}</h3><button class="btn secondary small" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Supplier</div><div><b>${esc(supplierName(supplier(note.supplier_id)))}</b></div></div>
        <div class="card"><div class="stat-title">Date</div><div><b>${esc((note.received_date || note.received_at || note.created_at || "").slice(0,10))}</b></div></div>
        <div class="card"><div class="stat-title">Total</div><div><b>${money(note.total_amount)}</b></div></div>
      </div>
      <table>
        <thead><tr><th>Item</th><th>Delivered</th><th>Accepted</th><th>Rejected</th><th>Billing</th><th>Total</th><th>Reason</th></tr></thead>
        <tbody>
          ${lines.map(line => {
            const it = item(line.item_id);
            return `<tr>
              <td>${esc(itemLabel(it))}</td>
              <td>${qty(line.delivered_qty || line.received_qty)} ${esc(line.receive_unit || line.order_unit || "")}</td>
              <td>${qty(line.accepted_qty)} ${esc(line.receive_unit || line.order_unit || "")}</td>
              <td>${qty(line.rejected_qty || 0)}</td>
              <td>${line.secondary_qty ? `${qty(line.secondary_qty)} ${esc(line.secondary_unit || line.cost_unit || "")}` : "Auto"}</td>
              <td>${money(line.line_total || (Number(line.accepted_qty||0)*Number(line.actual_unit_price||line.unit_price||0)))}</td>
              <td>${esc(line.rejection_reason || line.reject_reason || "")}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button><button class="btn" id="copyOpenRn">Copy Text</button></div>
  `);
  $("copyOpenRn").onclick = () => copyReceivingNote(note);
}

function copyReceivingNote(note) {
  if (!note) return;
  const lines = receivingLines.filter(line => (line.grn_id || line.receiving_note_id) === note.id);
  const text = [
    `Receiving Note: ${rnNo(note)}`,
    `Supplier: ${supplierName(supplier(note.supplier_id))}`,
    `Date: ${(note.received_date || note.received_at || note.created_at || "").slice(0,10)}`,
    "",
    ...lines.map((line, index) => {
      const it = item(line.item_id);
      return `${index + 1}. ${itemLabel(it)} - Delivered ${qty(line.delivered_qty || line.received_qty)} ${line.receive_unit || line.order_unit || line.stock_unit || ""}, Accepted ${qty(line.accepted_qty)}, Rejected ${qty(line.rejected_qty || 0)}${line.rejection_reason || line.reject_reason ? " - " + (line.rejection_reason || line.reject_reason) : ""}`;
    }),
    "",
    `Total: ${money(note.total_amount)}`
  ].join("\n");
  navigator.clipboard.writeText(text);
  toast("Receiving note copied.", "ok");
}
