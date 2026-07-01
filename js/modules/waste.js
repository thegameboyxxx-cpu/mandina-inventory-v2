import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal, today } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";
import { loadItems } from "./items.js";

let wasteEntries = [];
let balances = [];
let profiles = [];
let filters = { search: "", status: "" };

const item = id => (state.items || []).find(i => i.id === id);
const itemLabel = item => item ? `${item.name}${item.name_ar ? " / " + item.name_ar : ""}` : "Item";
const profileName = id => profiles.find(p => p.id === id)?.full_name || (id ? String(id).slice(0, 8) : "-");
const wasteNo = w => w?.waste_number || `WE-${String(w?.id || "").slice(0, 8)}`;
const currentQty = itemId => {
  const bal = balances.find(b => b.item_id === itemId);
  return Number(bal?.qty_on_hand ?? bal?.current_qty ?? bal?.quantity ?? 0);
};
const reasons = ["Expired", "Burned", "Spilled", "Over-prepared", "Customer return", "Buffet leftover", "Production loss", "Damaged packaging", "Wrong preparation", "Staff mistake", "Supplier quality issue", "Other"];

async function loadWasteData() {
  await loadItems();
  wasteEntries = await safeSelect("waste_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  balances = await safeSelect("stock_balances", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []);
  profiles = isManager() ? await safeSelect("profiles", "*").catch(() => []) : [];
}

export async function renderWaste() {
  const content = $("content");
  content.innerHTML = '<div class="card">Loading wastage...</div>';

  try {
    await loadWasteData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Wastage</h2>
          <div class="toolbar">
            <input id="wasteSearch" class="input" placeholder="Search waste...">
            <select id="wasteStatusFilter"><option value="">All status</option><option value="recorded">Recorded</option><option value="cancelled">Cancelled</option></select>
            <button class="btn" id="addWasteBtn">+ Record Waste</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Waste deducts stock immediately. Incorrect waste should be cancelled with a reversal, not deleted.</div>
        <div id="wasteTable"></div>
      </div>
    `;
    $("wasteSearch").value = filters.search;
    $("wasteStatusFilter").value = filters.status;
    $("wasteSearch").oninput = e => { filters.search = e.target.value; renderWasteTable(); };
    $("wasteStatusFilter").onchange = e => { filters.status = e.target.value; renderWasteTable(); };
    $("addWasteBtn").onclick = openWasteModal;
    renderWasteTable();
  } catch (e) {
    content.innerHTML = showError("Could not load Wastage. " + e.message);
  }
}

function renderWasteTable() {
  const q = filters.search.toLowerCase();
  const rows = wasteEntries
    .filter(w => !filters.status || (w.status || "recorded") === filters.status)
    .filter(w => !q || JSON.stringify({ ...w, item: itemLabel(item(w.item_id)) }).toLowerCase().includes(q));
  const total = rows.filter(w => (w.status || "recorded") !== "cancelled").reduce((s, w) => s + Number(w.estimated_cost || 0), 0);

  $("wasteTable").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Entries</div><div><b>${rows.length}</b></div></div>
      <div class="card"><div class="stat-title">Estimated Cost</div><div><b>${money(total)}</b></div></div>
      <div class="card"><div class="stat-title">Recorded Today</div><div><b>${wasteEntries.filter(w => (w.waste_date || "").slice(0, 10) === today()).length}</b></div></div>
    </div>
    <table>
      <thead><tr><th>Waste</th><th>Date</th><th>Item</th><th>Qty</th><th>Reason</th><th>Status</th>${isManager() ? "<th>Recorded By</th>" : ""}<th></th></tr></thead>
      <tbody>
        ${rows.map(w => {
          const it = item(w.item_id);
          return `<tr>
            <td><b>${esc(wasteNo(w))}</b></td>
            <td>${esc((w.waste_date || w.created_at || "").slice(0, 10))}</td>
            <td>${esc(itemLabel(it))}</td>
            <td>${qty(w.qty)} ${esc(w.unit || it?.stock_unit || "")}</td>
            <td>${esc(w.reason || "")}</td>
            <td><span class="badge ${(w.status || "recorded") === "cancelled" ? "red" : "green"}">${esc(w.status || "recorded")}</span></td>
            ${isManager() ? `<td>${esc(profileName(w.created_by))}</td>` : ""}
            <td>
              <button class="btn secondary small view-waste" data-id="${esc(w.id)}">View</button>
              ${isManager() && (w.status || "recorded") !== "cancelled" ? `<button class="btn red small cancel-waste" data-id="${esc(w.id)}">Cancel</button>` : ""}
            </td>
          </tr>`;
        }).join("") || `<tr><td colspan="${isManager() ? 8 : 7}" class="muted">No waste entries yet.</td></tr>`}
      </tbody>
    </table>
  `;
  document.querySelectorAll(".view-waste").forEach(btn => btn.onclick = () => openWasteDetails(wasteEntries.find(w => w.id === btn.dataset.id)));
  document.querySelectorAll(".cancel-waste").forEach(btn => btn.onclick = () => cancelWaste(wasteEntries.find(w => w.id === btn.dataset.id)));
}

function stockItemOptions() {
  return '<option value="">-- Select item --</option>' + (state.items || []).filter(i => i.active !== false).map(i => `<option value="${esc(i.id)}">${esc(itemLabel(i))}</option>`).join("");
}

function openWasteModal() {
  openModal(`
    <div class="modal-head"><h3>Record Waste</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="wasteForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Waste Date</label><input name="waste_date" type="date" class="input" value="${today()}" required></div>
          <div><label>Item</label><select name="item_id" id="wasteItem" required>${stockItemOptions()}</select><div class="muted" id="wasteStockText"></div></div>
          <div><label>Waste Qty</label><input name="qty" type="number" step="0.001" class="input" required></div>
          <div><label>Unit</label><input name="unit" id="wasteUnit" class="input" required readonly></div>
          <div><label>Reason</label><select name="reason" required>${reasons.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select></div>
          <div><label>Estimated Cost</label><input name="estimated_cost" type="number" step="0.01" class="input" value="0"></div>
          <div class="full"><label>Photo</label><input name="photo" type="file" accept="image/*" class="input"><div class="muted">Optional. A small photo is saved with the waste entry.</div></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save Waste</button></div>
    </form>
  `);
  $("wasteItem").onchange = e => {
    const it = item(e.target.value);
    $("wasteUnit").value = it?.stock_unit || "";
    $("wasteStockText").textContent = it ? `Current stock: ${qty(currentQty(it.id))} ${it.stock_unit || ""}` : "";
  };
  $("wasteForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const it = item(fd.get("item_id"));
    const amount = Number(fd.get("qty") || 0);
    if (amount <= 0) return toast("Waste quantity must be greater than zero.", "error");
    if (fd.get("reason") === "Other" && !String(fd.get("notes") || "").trim()) return toast("Notes are required when reason is Other.", "error");
    try {
      const photo = fd.get("photo");
      const photoUrl = photo && photo.size ? await fileToDataUrl(photo) : null;
      const entry = await insertRow("waste_entries", {
        waste_number: `WE-${Date.now().toString().slice(-8)}`,
        branch_id: state.currentBranchId,
        waste_date: fd.get("waste_date"),
        item_id: it.id,
        qty: amount,
        unit: it.stock_unit || fd.get("unit"),
        reason: fd.get("reason"),
        notes: fd.get("notes") || null,
        photo_url: photoUrl,
        estimated_cost: Number(fd.get("estimated_cost") || 0),
        status: "recorded",
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      await addMovement({ item_id: it.id, qty_change: -Math.abs(amount), stock_unit: it.stock_unit || fd.get("unit"), reference_id: entry.id, notes: `Waste ${wasteNo(entry)}: ${fd.get("reason")}` });
      toast("Waste recorded.", "ok");
      closeModal();
      renderWaste();
    } catch (err) {
      toast("Waste save failed: " + err.message, "error");
    }
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function openWasteDetails(entry) {
  if (!entry) return;
  const it = item(entry.item_id);
  openModal(`
    <div class="modal-head"><h3>${esc(wasteNo(entry))}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Item</div><div><b>${esc(itemLabel(it))}</b></div></div>
        <div class="card"><div class="stat-title">Qty</div><div><b>${qty(entry.qty)} ${esc(entry.unit || it?.stock_unit || "")}</b></div></div>
        <div class="card"><div class="stat-title">Status</div><div><b>${esc(entry.status || "recorded")}</b></div></div>
      </div>
      <div class="form-grid">
        <div><label>Date</label><input class="input" value="${esc((entry.waste_date || entry.created_at || "").slice(0, 10))}" disabled></div>
        <div><label>Reason</label><input class="input" value="${esc(entry.reason || "")}" disabled></div>
        <div><label>Estimated Cost</label><input class="input" value="${money(entry.estimated_cost || 0)}" disabled></div>
        ${isManager() ? `<div><label>Recorded By</label><input class="input" value="${esc(profileName(entry.created_by))}" disabled></div>` : ""}
        <div class="full"><label>Notes</label><textarea class="input" rows="4" disabled>${esc(entry.notes || "")}</textarea></div>
        <div class="full"><label>Photo</label>${entry.photo_url ? `<img src="${esc(entry.photo_url)}" alt="Waste photo" style="max-width:100%;border-radius:12px;border:1px solid var(--line)">` : `<div class="muted">No photo attached.</div>`}</div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
}

async function addMovement({ item_id, qty_change, stock_unit, reference_id, notes }) {
  const { error } = await state.db.from("stock_movements").insert({
    branch_id: state.currentBranchId,
    item_id,
    movement_type: "WASTE",
    qty_change,
    qty: qty_change,
    quantity: qty_change,
    stock_unit,
    unit: stock_unit,
    reference_id,
    reference_type: "wastage",
    notes,
    created_by: state.user.id,
  });
  if (error) throw error;
}

async function cancelWaste(entry) {
  if (!entry) return;
  const it = item(entry.item_id);
  try {
    await state.db.from("stock_movements").insert({
      branch_id: state.currentBranchId,
      item_id: entry.item_id,
      movement_type: "MANAGER_ADJUSTMENT",
      qty_change: Math.abs(Number(entry.qty || 0)),
      qty: Math.abs(Number(entry.qty || 0)),
      quantity: Math.abs(Number(entry.qty || 0)),
      stock_unit: entry.unit || it?.stock_unit || "",
      unit: entry.unit || it?.stock_unit || "",
      reference_id: entry.id,
      reference_type: "wastage_reversal",
      notes: `Reversal for cancelled waste ${wasteNo(entry)}`,
      created_by: state.user.id,
    });
    await updateRow("waste_entries", entry.id, { status: "cancelled", cancelled_by: state.user.id, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    toast("Waste cancelled and stock reversed.", "ok");
    renderWaste();
  } catch (err) {
    toast("Cancel failed: " + err.message, "error");
  }
}
