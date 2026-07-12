import { state, isManager } from "../state.js";
import { $, esc, qty, showError, toast, openModal, closeModal, today } from "../utils.js";
import { safeSelect, insertRow, updateRow, deleteRows } from "../services/db.js";
import { loadItemDeps, loadItems } from "./items.js";

let counts = [];
let countLines = [];
let balances = [];
let profiles = [];
let filters = { status: "", type: "", search: "" };

const itemLabel = item => item ? `${item.name}${item.name_ar ? " / " + item.name_ar : ""}` : "Item";
const item = id => (state.items || []).find(i => i.id === id);
const categoryName = id => (state.categories || []).find(c => c.id === id)?.name || "";
const profileName = id => profiles.find(p => p.id === id)?.full_name || (id ? String(id).slice(0, 8) : "-");
const countNo = c => c?.count_number || `SC-${String(c?.id || "").slice(0, 8)}`;
const countDate = c => (c?.count_date || c?.created_at || "").slice(0, 10);
const currentQty = itemId => {
  const bal = balances.find(b => b.item_id === itemId);
  return Number(bal?.qty_on_hand ?? bal?.current_qty ?? bal?.quantity ?? 0);
};
const countedPresent = line => line?.counted_qty !== null && line?.counted_qty !== undefined && line?.counted_qty !== "";
const varianceForLine = line => countedPresent(line) ? Number(line.counted_qty || 0) - Number(line.expected_qty || 0) : 0;
const statusBadge = status => {
  const value = status || "draft";
  const cls = value === "approved" ? "green" : value === "submitted" ? "gold" : value === "rejected" || value === "cancelled" ? "red" : "blue";
  return `<span class="badge ${cls}">${esc(value)}</span>`;
};
const countTypeLabel = type => ({
  all: "All",
  raw: "Raw Items",
  produced: "Produced Items",
  food_production: "Food Production",
  fill_up: "Fill Up",
  category: "Category",
}[type] || type || "All");
const varianceReasonOptions = [
  "",
  "Waste not recorded",
  "Production not recorded",
  "Sales not synced",
  "Staff meal not recorded",
  "Wrong receiving",
  "Wrong production quantity",
  "Theft/suspected missing",
  "Counting mistake",
  "Unit conversion issue",
  "Other",
];

async function loadCountData() {
  await loadItemDeps();
  await loadItems();
  counts = await safeSelect("stock_counts", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  countLines = await safeSelect("stock_count_lines", "*").catch(() => []);
  balances = await safeSelect("stock_balances", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []);
  profiles = isManager() ? await safeSelect("profiles", "*").catch(() => []) : [];
}

export async function renderCounts() {
  const content = $("content");
  content.innerHTML = '<div class="card">Loading daily counts...</div>';

  try {
    await loadCountData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Daily Count</h2>
          <div class="toolbar">
            <input id="countSearch" class="input" placeholder="Search count...">
            <select id="countStatusFilter">
              <option value="">All status</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select id="countTypeFilter">
              <option value="">All types</option>
              <option value="all">All</option>
              <option value="raw">Raw Items</option>
              <option value="produced">Produced Items</option>
              <option value="food_production">Food Production</option>
              <option value="fill_up">Fill Up</option>
              <option value="category">Category</option>
            </select>
            <button class="btn" id="newCountBtn">+ New Count</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">
          Count physical stock in stock units. Stock changes only after manager approval.
        </div>
        <div id="countsTable"></div>
      </div>
    `;

    $("countSearch").value = filters.search;
    $("countStatusFilter").value = filters.status;
    $("countTypeFilter").value = filters.type;
    $("countSearch").oninput = e => { filters.search = e.target.value; renderCountsTable(); };
    $("countStatusFilter").onchange = e => { filters.status = e.target.value; renderCountsTable(); };
    $("countTypeFilter").onchange = e => { filters.type = e.target.value; renderCountsTable(); };
    $("newCountBtn").onclick = openNewCountModal;
    renderCountsTable();
  } catch (e) {
    content.innerHTML = showError("Could not load Daily Count. " + e.message);
  }
}

function renderCountsTable() {
  const q = filters.search.toLowerCase();
  const rows = counts
    .filter(c => !filters.status || (c.status || "draft") === filters.status)
    .filter(c => !filters.type || (c.count_type || "all") === filters.type)
    .filter(c => !q || JSON.stringify(c).toLowerCase().includes(q));

  const summary = counts.reduce((acc, c) => {
    const key = c.status || "draft";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  $("countsTable").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Draft</div><div><b>${summary.draft || 0}</b></div></div>
      <div class="card"><div class="stat-title">Submitted</div><div><b>${summary.submitted || 0}</b></div></div>
      <div class="card"><div class="stat-title">Approved</div><div><b>${summary.approved || 0}</b></div></div>
      <div class="card"><div class="stat-title">Rejected</div><div><b>${summary.rejected || 0}</b></div></div>
    </div>
    <table>
      <thead><tr><th>Count</th><th>Date</th><th>Type</th><th>Lines</th><th>Variance</th><th>Status</th>${isManager() ? "<th>Submitted By</th>" : ""}<th></th></tr></thead>
      <tbody>
        ${rows.map(c => {
          const lines = linesFor(c.id);
          const varianceTotal = lines.reduce((s, l) => s + varianceForLine(l), 0);
          return `<tr>
            <td><b>${esc(countNo(c))}</b><div class="muted">${esc(c.notes || "")}</div></td>
            <td>${esc(countDate(c))}</td>
            <td>${esc(countTypeLabel(c.count_type))}${c.category_id ? `<div class="muted">${esc(categoryName(c.category_id))}</div>` : ""}</td>
            <td>${lines.length}</td>
            <td><span class="badge ${varianceTotal < 0 ? "red" : varianceTotal > 0 ? "gold" : "green"}">${qty(varianceTotal)}</span></td>
            <td>${statusBadge(c.status)}</td>
            ${isManager() ? `<td>${esc(profileName(c.submitted_by || c.created_by))}</td>` : ""}
            <td><button class="btn secondary small open-count" data-id="${esc(c.id)}">${canEdit(c) ? "Open" : "View"}</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="${isManager() ? 8 : 7}" class="muted">No counts yet.</td></tr>`}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".open-count").forEach(btn => btn.onclick = () => openCountEditor(counts.find(c => c.id === btn.dataset.id)));
}

function linesFor(countId) {
  return countLines.filter(l => l.count_id === countId);
}

function canEdit(count) {
  return ["draft", "rejected"].includes(count?.status || "draft");
}

function canReview(count) {
  return isManager() && (count?.status || "draft") === "submitted";
}

function canDeleteDraftCount(count) {
  return (count?.status || "draft") === "draft";
}

function branchName() {
  const b = (state.branches || []).find(x => x.id === state.currentBranchId) || {};
  return b.name || b.branch_name || b.title || state.currentBranchId || "";
}

function itemMatchesCountType(it, type, categoryId) {
  if (it.active === false) return false;
  if (type === "raw") return (it.item_type || "raw") === "raw";
  if (type === "produced") return it.item_type === "produced";
  if (type === "food_production") return it.item_type === "produced" && (it.production_kind || "food_production") === "food_production";
  if (type === "fill_up") return it.item_type === "produced" && it.production_kind === "fill_up";
  if (type === "category") return it.category_id === categoryId;
  return true;
}

function openNewCountModal() {
  openModal(`
    <div class="modal-head"><h3>New Daily Count</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="newCountForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Branch</label><input class="input" value="${esc(branchName())}" disabled></div>
          <div><label>Count Date</label><input name="count_date" type="date" class="input" value="${today()}" required></div>
          <div><label>Count Type</label><select name="count_type" id="newCountType">
            <option value="all">All</option>
            <option value="raw">Raw Items</option>
            <option value="produced">Produced Items</option>
            <option value="food_production">Food Production</option>
            <option value="fill_up">Fill Up</option>
            <option value="category">Category</option>
          </select></div>
          <div id="countCategoryWrap"><label>Category</label><select name="category_id">${[""].concat(state.categories || []).map(c => c ? `<option value="${esc(c.id)}">${esc(c.name)}</option>` : '<option value="">-- Select --</option>').join("")}</select></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn">Create Count</button>
      </div>
    </form>
  `);

  const updateCategory = () => $("countCategoryWrap").style.display = $("newCountType").value === "category" ? "" : "none";
  $("newCountType").onchange = updateCategory;
  updateCategory();

  $("newCountForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const type = fd.get("count_type") || "all";
    const categoryId = type === "category" ? fd.get("category_id") : null;
    if (type === "category" && !categoryId) return toast("Select a category.", "error");

    const selectedItems = (state.items || [])
      .filter(it => itemMatchesCountType(it, type, categoryId))
      .sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));
    if (!selectedItems.length) return toast("No active items match this count type.", "error");

    try {
      const countNumber = `SC-${Date.now().toString().slice(-8)}`;
      const count = await insertRow("stock_counts", {
        count_number: countNumber,
        branch_id: state.currentBranchId,
        count_date: fd.get("count_date"),
        count_type: type,
        category_id: categoryId || null,
        status: "draft",
        notes: fd.get("notes") || null,
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      const rows = selectedItems.map(it => {
        const system = currentQty(it.id);
        return {
          count_id: count.id,
          item_id: it.id,
          expected_qty: system,
          counted_qty: null,
          count_unit: it.stock_unit || "",
          notes: null,
          requires_manager_review: true,
          approved_adjustment_qty: null,
        };
      });
      const { error } = await state.db.from("stock_count_lines").insert(rows);
      if (error) throw error;
      await loadCountData();
      closeModal();
      openCountEditor(counts.find(c => c.id === count.id) || count);
    } catch (err) {
      toast("Count creation failed: " + err.message, "error");
    }
  };
}

function openCountEditor(count) {
  const readOnly = !canEdit(count);
  const managerReview = canReview(count);
  const computedVariance = line => countedPresent(line) ? Number(line.counted_qty || 0) - Number(line.expected_qty || 0) : null;
  let localLines = linesFor(count.id).map(l => {
    const line = { ...l };
    line.variance = computedVariance(line);
    if ((count.status || "draft") !== "approved") line.approved_adjustment_qty = line.variance;
    return line;
  });
  let search = "";
  let lineFilter = "";

  openModal(`
    <div class="modal-head">
      <h3>${esc(countNo(count))}</h3>
      <button class="btn secondary small" id="closeCountEditorTop">x</button>
    </div>
    <div class="modal-body">
      <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Branch</div><div><b>${esc(branchName())}</b></div></div>
        <div class="card"><div class="stat-title">Date</div><div><b>${esc(countDate(count))}</b></div></div>
        <div class="card"><div class="stat-title">Type</div><div><b>${esc(countTypeLabel(count.count_type))}</b></div></div>
        <div class="card"><div class="stat-title">Status</div><div>${statusBadge(count.status)}</div></div>
      </div>
      ${isManager() ? `<div class="muted" style="margin-bottom:12px">Created by ${esc(profileName(count.created_by))}${count.submitted_by ? ` / Submitted by ${esc(profileName(count.submitted_by))}` : ""}${count.approved_by ? ` / Approved by ${esc(profileName(count.approved_by))}` : ""}</div>` : ""}
      <div class="toolbar" style="margin-bottom:12px">
        <input id="countLineSearch" class="input" placeholder="Search item...">
        <select id="countLineFilter"><option value="">All lines</option><option value="counted">Counted</option><option value="missing">Not counted</option><option value="variance">Variance</option></select>
      </div>
      <div id="countLineSummary"></div>
      <div id="countLineCards"></div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn secondary" id="closeCountEditorBtn">Close</button>
      ${canDeleteDraftCount(count) ? `<button type="button" class="btn red" id="deleteDraftCountBtn">Delete Draft</button>` : ""}
      ${readOnly ? "" : `<button type="button" class="btn secondary" id="saveCountDraftBtn">Save Draft</button><button type="button" class="btn green" id="submitCountBtn">Submit Count</button>`}
      ${managerReview ? `<button type="button" class="btn red" id="rejectCountBtn">Reject</button><button type="button" class="btn green" id="approveCountBtn">Approve Adjustments</button>` : ""}
    </div>
  `);

  function recalcLine(line) {
    if (line.counted_qty === null || line.counted_qty === undefined || line.counted_qty === "") {
      line.variance = null;
      line.approved_adjustment_qty = null;
      return;
    }
    line.variance = Number(line.counted_qty || 0) - Number(line.expected_qty || 0);
    line.approved_adjustment_qty = line.variance;
  }

  function visibleLines() {
    const q = search.toLowerCase();
    return localLines
      .filter(line => {
        const it = item(line.item_id);
        if (q && !JSON.stringify({ ...line, name: itemLabel(it), category: categoryName(it?.category_id) }).toLowerCase().includes(q)) return false;
        if (lineFilter === "counted") return line.counted_qty !== null && line.counted_qty !== undefined && line.counted_qty !== "";
        if (lineFilter === "missing") return line.counted_qty === null || line.counted_qty === undefined || line.counted_qty === "";
        if (lineFilter === "variance") return Number(line.variance || 0) !== 0;
        return true;
      });
  }

  function renderLines() {
    const counted = localLines.filter(l => l.counted_qty !== null && l.counted_qty !== undefined && l.counted_qty !== "").length;
    const varianceLines = localLines.filter(l => Number(l.variance || 0) !== 0);
    const varianceTotal = varianceLines.reduce((s, l) => s + Number(l.variance || 0), 0);
    $("countLineSummary").innerHTML = `
      <div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Counted</div><div><b>${counted}/${localLines.length}</b></div></div>
        <div class="card"><div class="stat-title">Variance Lines</div><div><b>${varianceLines.length}</b></div></div>
        <div class="card"><div class="stat-title">Total Variance Qty</div><div><b>${qty(varianceTotal)}</b></div></div>
      </div>
    `;
    $("countLineCards").innerHTML = `
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
        ${visibleLines().map(line => lineCard(line)).join("") || `<div class="muted">No matching items.</div>`}
      </div>
    `;
    bindLineInputs();
  }

  function lineCard(line) {
    const it = item(line.item_id);
    const variance = line.variance === null || line.variance === undefined ? null : Number(line.variance || 0);
    const badge = variance === null ? '<span class="badge blue">Not counted</span>' : `<span class="badge ${variance < 0 ? "red" : variance > 0 ? "gold" : "green"}">${qty(variance)}</span>`;
    const reasonOptions = varianceReasonOptions.map(r => `<option value="${esc(r)}" ${r === (line.variance_reason || "") ? "selected" : ""}>${esc(r || "-- Reason --")}</option>`).join("");
    return `
      <div class="card" data-line-card="${esc(line.id)}">
        <div class="section-head" style="margin-bottom:10px">
          <div><b>${esc(itemLabel(it))}</b><div class="muted">${esc(categoryName(it?.category_id))}</div></div>
          ${badge}
        </div>
        <div class="form-grid">
          <div><label>System Qty</label><input class="input" value="${qty(line.expected_qty || 0)} ${esc(line.count_unit || it?.stock_unit || "")}" disabled></div>
          <div><label>Counted Qty</label><input class="input counted-input" data-id="${esc(line.id)}" type="number" step="0.001" value="${esc(line.counted_qty ?? "")}" ${readOnly ? "disabled" : ""}></div>
          <div><label>Unit</label><input class="input" value="${esc(line.count_unit || it?.stock_unit || "")}" disabled></div>
          <div><label>Variance</label><input class="input variance-display" data-id="${esc(line.id)}" value="${variance === null ? "" : qty(variance)}" disabled></div>
          <div class="full"><label>Reason</label><select class="reason-input" data-id="${esc(line.id)}" ${readOnly ? "disabled" : ""}>${reasonOptions}</select></div>
          <div class="full"><label>Notes</label><textarea class="input note-input" data-id="${esc(line.id)}" rows="2" ${readOnly ? "disabled" : ""}>${esc(line.notes || "")}</textarea></div>
          ${managerReview ? `<div class="full"><label>Approved Adjustment Qty</label><input class="input approved-input" data-id="${esc(line.id)}" type="number" step="0.001" value="${esc(line.approved_adjustment_qty ?? line.variance ?? "")}"></div>` : ""}
        </div>
      </div>
    `;
  }

  function updateCard(line) {
    const card = document.querySelector(`[data-line-card="${CSS.escape(line.id)}"]`);
    if (!card) return;
    const variance = line.variance === null || line.variance === undefined ? null : Number(line.variance || 0);
    const display = card.querySelector(".variance-display");
    if (display) display.value = variance === null ? "" : qty(variance);
    const badge = card.querySelector(".section-head .badge");
    if (badge) {
      badge.className = `badge ${variance === null ? "blue" : variance < 0 ? "red" : variance > 0 ? "gold" : "green"}`;
      badge.textContent = variance === null ? "Not counted" : qty(variance);
    }
  }

  function bindLineInputs() {
    document.querySelectorAll(".counted-input").forEach(el => el.oninput = e => {
      const line = localLines.find(l => l.id === e.target.dataset.id);
      if (!line) return;
      line.counted_qty = e.target.value === "" ? null : Number(e.target.value || 0);
      recalcLine(line);
      updateCard(line);
    });
    document.querySelectorAll(".reason-input").forEach(el => el.onchange = e => {
      const line = localLines.find(l => l.id === e.target.dataset.id);
      if (line) line.variance_reason = e.target.value || null;
    });
    document.querySelectorAll(".note-input").forEach(el => el.oninput = e => {
      const line = localLines.find(l => l.id === e.target.dataset.id);
      if (line) line.notes = e.target.value;
    });
    document.querySelectorAll(".approved-input").forEach(el => el.oninput = e => {
      const line = localLines.find(l => l.id === e.target.dataset.id);
      if (line) line.approved_adjustment_qty = e.target.value === "" ? null : Number(e.target.value || 0);
    });
  }

  async function saveLines() {
    const payload = localLines.map(line => ({
        id: line.id,
        counted_qty: line.counted_qty === "" ? null : line.counted_qty,
        variance_reason: line.variance_reason || null,
        notes: line.notes || null,
        requires_manager_review: Number(line.variance || 0) !== 0,
        approved_adjustment_qty: managerReview ? (line.approved_adjustment_qty === "" ? null : line.approved_adjustment_qty) : computedVariance(line),
        updated_at: new Date().toISOString(),
      }));
    const { error } = await state.db.from("stock_count_lines").upsert(payload);
    if (error) throw error;
  }

  async function refreshAfter(message) {
    toast(message, "ok");
    closeModal();
    await renderCounts();
  }

  function hasAnyCountedQty() {
    return localLines.some(line => line.counted_qty !== null && line.counted_qty !== undefined && line.counted_qty !== "");
  }

  async function deleteDraftCount(message = "Draft count deleted.") {
    if (!canDeleteDraftCount(count)) return toast("Only draft counts can be deleted.", "error");
    try {
      await deleteRows("stock_count_lines", "count_id", count.id);
      await deleteRows("stock_counts", "id", count.id);
      await refreshAfter(message);
    } catch (e) {
      toast("Delete failed: " + e.message, "error");
    }
  }

  async function closeCountEditor() {
    if (canDeleteDraftCount(count) && !hasAnyCountedQty()) {
      const shouldDelete = confirm("No quantities have been entered. Delete this empty draft instead of keeping it?");
      if (shouldDelete) return deleteDraftCount("Empty draft count deleted.");
    }
    closeModal();
  }

  $("countLineSearch").oninput = e => { search = e.target.value; renderLines(); };
  $("countLineFilter").onchange = e => { lineFilter = e.target.value; renderLines(); };
  $("closeCountEditorBtn").onclick = closeCountEditor;
  $("closeCountEditorTop").onclick = closeCountEditor;

  if ($("deleteDraftCountBtn")) $("deleteDraftCountBtn").onclick = async () => {
    if (!confirm(`Delete draft ${countNo(count)}? This removes the count and its empty lines.`)) return;
    await deleteDraftCount();
  };

  if ($("saveCountDraftBtn")) $("saveCountDraftBtn").onclick = async () => {
    try {
      await saveLines();
      await updateRow("stock_counts", count.id, { status: "draft", updated_at: new Date().toISOString() });
      await refreshAfter("Count draft saved.");
    } catch (e) {
      toast("Save failed: " + e.message, "error");
    }
  };

  if ($("submitCountBtn")) $("submitCountBtn").onclick = async () => {
    try {
      await saveLines();
      await updateRow("stock_counts", count.id, {
        status: "submitted",
        submitted_by: state.user.id,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await refreshAfter("Count submitted for manager review.");
    } catch (e) {
      toast("Submit failed: " + e.message, "error");
    }
  };

  if ($("rejectCountBtn")) $("rejectCountBtn").onclick = async () => {
    try {
      await updateRow("stock_counts", count.id, {
        status: "rejected",
        rejected_by: state.user.id,
        rejected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await refreshAfter("Count rejected.");
    } catch (e) {
      toast("Reject failed: " + e.message, "error");
    }
  };

  if ($("approveCountBtn")) $("approveCountBtn").onclick = async () => {
    try {
      await saveLines();
      const adjustments = localLines.filter(l => l.counted_qty !== null && l.counted_qty !== undefined && l.counted_qty !== "" && Number(l.approved_adjustment_qty ?? l.variance ?? 0) !== 0);
      const movements = adjustments.map(line => {
        const it = item(line.item_id);
        const adj = Number(line.approved_adjustment_qty ?? line.variance ?? 0);
        return {
          branch_id: state.currentBranchId,
          item_id: line.item_id,
          movement_type: "DAILY_COUNT_ADJUSTMENT",
          qty_change: adj,
          qty: adj,
          quantity: adj,
          stock_unit: line.count_unit || it?.stock_unit || "",
          unit: line.count_unit || it?.stock_unit || "",
          reference_id: count.id,
          reference_type: "daily_count",
          notes: `Daily count ${countNo(count)} adjustment${line.variance_reason ? ": " + line.variance_reason : ""}`,
          created_by: state.user.id,
        };
      });
      if (movements.length) {
        const { error } = await state.db.from("stock_movements").insert(movements);
        if (error) throw error;
      }
      await updateRow("stock_counts", count.id, {
        status: "approved",
        approved_by: state.user.id,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await refreshAfter("Count approved and stock adjusted.");
    } catch (e) {
      toast("Approval failed: " + e.message, "error");
    }
  };

  renderLines();
}
