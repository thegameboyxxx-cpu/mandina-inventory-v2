import { state, isManager } from "../state.js";
import { $, esc, showError, toast, openModal, closeModal } from "../utils.js";
import { unitSelect } from "../units.js";
import { safeSelect } from "../services/db.js";
import { supplierName } from "./suppliers.js";

export async function loadItemDeps() {
  const [suppliers, categories] = await Promise.all([
    safeSelect("suppliers", "*").catch(() => []),
    safeSelect("item_categories", "*", { order: "sort_order" }).catch(() => []),
  ]);
  state.suppliers = suppliers;
  state.categories = categories;
}

export async function loadItems() {
  state.items = await safeSelect("items", "*", { order: "created_at", ascending: false }).catch(() => safeSelect("items", "*"));
}

const categoryName = id => state.categories.find(c => c.id === id)?.name || "";
const supplierLabel = id => supplierName(state.suppliers.find(s => s.id === id));
const options = (rows, selected, labelFn) => '<option value="">-- Select --</option>' + rows.map(row => (
  `<option value="${esc(row.id)}" ${row.id === selected ? "selected" : ""}>${esc(labelFn(row))}</option>`
)).join("");
const itemType = item => item?.item_type || "raw";
const itemTypeBadge = item => itemType(item) === "produced"
  ? '<span class="badge green">Produced</span>'
  : '<span class="badge gold">Raw</span>';

function packageText(item) {
  const type = item.purchase_package_type || "";
  const amount = item.purchase_package_qty ?? "";
  const unit = item.purchase_package_unit || "";
  return (!type && !amount && !unit) ? "" : `${type} ${amount} ${unit}`.trim();
}

function receivingText(item) {
  return packageText(item)
    ? `${item.receiving_unit || item.purchase_package_type || ""} (${packageText(item)})`
    : item.receiving_unit || item.purchase_package_type || "";
}

async function itemHasHistory(itemId) {
  const checks = await Promise.all([
    state.db.from("stock_movements").select("id", { count: "exact", head: true }).eq("item_id", itemId),
    state.db.from("purchase_order_lines").select("id", { count: "exact", head: true }).eq("item_id", itemId),
    state.db.from("receiving_note_lines").select("id", { count: "exact", head: true }).eq("item_id", itemId),
  ].map(p => p.catch(() => ({ count: 0 }))));
  return checks.some(result => Number(result.count || 0) > 0);
}

export async function renderItems() {
  if (!isManager()) return $("content").innerHTML = showError("Staff users cannot access Items.");

  const content = $("content");
  content.innerHTML = '<div class="card">Loading items...</div>';

  try {
    await loadItemDeps();
    await loadItems();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Items</h2>
          <div class="toolbar">
            <input id="itemSearch" class="input" placeholder="Search item...">
            <button class="btn secondary" id="addCatBtn">+ Category</button>
            <button class="btn" id="addItemBtn">+ Add Item</button>
          </div>
        </div>
        <div id="itemsTable"></div>
      </div>
    `;
    $("itemSearch").oninput = renderItemsTable;
    $("addItemBtn").onclick = () => openItemModal();
    $("addCatBtn").onclick = openCategoryModal;
    renderItemsTable();
  } catch (e) {
    content.innerHTML = showError(e.message);
  }
}

function renderItemsTable() {
  const q = ($("itemSearch")?.value || "").toLowerCase();
  const rows = state.items.filter(item => JSON.stringify(item).toLowerCase().includes(q));

  $("itemsTable").innerHTML = `
    <table>
      <thead><tr><th>Item</th><th>Type</th><th>Category</th><th>Supplier</th><th>Receiving</th><th>Stock Unit</th><th>Cost Unit</th><th>Recipe</th><th></th></tr></thead>
      <tbody>
        ${rows.map(item => `<tr>
          <td><b>${esc(item.name)}</b><div class="muted">${esc(item.name_ar || "")}</div></td>
          <td>${itemTypeBadge(item)}</td>
          <td>${esc(categoryName(item.category_id))}</td>
          <td>${esc(supplierLabel(item.primary_supplier_id))}</td>
          <td>${esc(receivingText(item))}</td>
          <td>${esc(item.stock_unit)}</td>
          <td>${esc(item.cost_unit || item.secondary_unit || item.stock_unit)}</td>
          <td>${item.is_recipe_controlled ? '<span class="badge green">Yes</span>' : '<span class="badge gold">Count only</span>'}</td>
          <td><button class="btn secondary small edit-item" data-id="${esc(item.id)}">Edit</button></td>
        </tr>`).join("") || '<tr><td colspan="9" class="muted">No items yet.</td></tr>'}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".edit-item").forEach(button => {
    button.onclick = () => openItemModal(state.items.find(item => item.id === button.dataset.id));
  });
}

async function openItemModal(item = null) {
  const edit = !!item;
  const unitsLocked = edit ? await itemHasHistory(item.id) : false;
  openModal(`
    <div class="modal-head">
      <h3>${edit ? "Edit Item" : "Add Item"}</h3>
      <button class="btn secondary small" onclick="closeModal()">x</button>
    </div>
    <form id="itemForm">
      <div class="modal-body">
        ${unitsLocked ? `<div class="errorbox">This item already has purchase, receiving, or stock history. Unit and package conversion fields are locked to protect existing stock history.</div>` : ""}
        <div class="form-grid">
          <div><label>Item Name</label><input name="name" class="input" required value="${esc(item?.name || "")}"></div>
          <div><label>Arabic Name</label><input name="name_ar" class="input" value="${esc(item?.name_ar || "")}"></div>
          <div><label>Item Type</label><select name="item_type"><option value="raw">Raw / Supplied Item</option><option value="produced">Produced Item</option></select><div class="muted">Produced items can be selected as production outputs.</div></div>
          <div><label>Category</label><select name="category_id">${options(state.categories, item?.category_id, c => c.name)}</select></div>
          <div><label>Primary Supplier</label><select name="primary_supplier_id">${options(state.suppliers, item?.primary_supplier_id, supplierName)}</select></div>
          <div><label>Receiving Unit</label>${unitSelect("receiving_unit", item?.receiving_unit || item?.purchase_package_type || "", `required ${unitsLocked ? "disabled" : ""}`)}<div class="muted">What staff count when goods arrive.</div></div>
          <div><label>Stock Unit</label>${unitSelect("stock_unit", item?.stock_unit || "", `required ${unitsLocked ? "disabled" : ""}`)}<div class="muted">Stock, counts, sales, waste and reorder use this.</div></div>
          <div><label>Cost / Billing Unit</label>${unitSelect("cost_unit", item?.cost_unit || item?.secondary_unit || item?.stock_unit || "", `required ${unitsLocked ? "disabled" : ""}`)}<div class="muted">Supplier invoice unit.</div></div>
          <div><label>Cost per Billing Unit</label><input name="default_purchase_price" type="number" step="0.01" class="input" value="${esc(item?.default_purchase_price ?? "")}"><div class="muted">Example: $18/kg, $50/bottle, $36/carton.</div></div>
          <div><label>Purchase Package Type</label><select name="purchase_package_type" ${unitsLocked ? "disabled" : ""}>${["", "bag", "box", "carton", "tray", "bucket", "bottle", "pack", "roll", "piece"].map(v => `<option value="${v}" ${v === (item?.purchase_package_type || "") ? "selected" : ""}>${v || "-- Select --"}</option>`).join("")}</select></div>
          <div><label>Package Quantity</label><input name="purchase_package_qty" type="number" step="0.001" class="input" value="${esc(item?.purchase_package_qty ?? "")}" ${unitsLocked ? "disabled" : ""}></div>
          <div><label>Package Unit</label>${unitSelect("purchase_package_unit", item?.purchase_package_unit || "", unitsLocked ? "disabled" : "")}</div>
          <div><label>Reorder Level</label><input name="reorder_level" type="number" step="0.001" class="input" value="${esc(item?.reorder_level ?? "")}"><div class="muted">Based on Stock Unit.</div></div>
          <div><label>Reorder Qty</label><input name="reorder_qty" type="number" step="0.001" class="input" value="${esc(item?.reorder_qty ?? "")}"><div class="muted">Based on receiving/order unit.</div></div>
          <div><label>Recipe/Sales Controlled?</label><select name="is_recipe_controlled"><option value="false">No - count report only</option><option value="true">Yes - sales variance alert</option></select></div>
          <div><label>Status</label><select name="active"><option value="true">Active</option><option value="false">Inactive</option></select></div>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn">Save</button>
      </div>
    </form>
  `);

  if (item?.is_recipe_controlled) document.querySelector("[name='is_recipe_controlled']").value = "true";
  if (item?.active === false) document.querySelector("[name='active']").value = "false";
  document.querySelector("[name='item_type']").value = itemType(item);

  $("itemForm").onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    const numberOrNull = key => form.get(key) === "" ? null : Number(form.get(key));
    const stockUnit = unitsLocked ? item.stock_unit : form.get("stock_unit");
    const costUnit = unitsLocked ? (item.cost_unit || item.secondary_unit || item.stock_unit) : form.get("cost_unit");
    const payload = {
      name: form.get("name"),
      name_ar: form.get("name_ar") || null,
      category_id: form.get("category_id") || null,
      primary_supplier_id: form.get("primary_supplier_id") || null,
      item_type: form.get("item_type") || "raw",
      receiving_unit: unitsLocked ? item.receiving_unit : form.get("receiving_unit"),
      cost_unit: costUnit,
      purchase_package_type: unitsLocked ? item.purchase_package_type : form.get("purchase_package_type") || null,
      purchase_package_qty: unitsLocked ? item.purchase_package_qty : numberOrNull("purchase_package_qty"),
      purchase_package_unit: unitsLocked ? item.purchase_package_unit : form.get("purchase_package_unit") || null,
      stock_unit: stockUnit,
      has_dual_unit: costUnit !== stockUnit,
      secondary_unit: costUnit !== stockUnit ? costUnit : null,
      reorder_level: numberOrNull("reorder_level"),
      reorder_qty: numberOrNull("reorder_qty"),
      default_purchase_price: numberOrNull("default_purchase_price"),
      is_recipe_controlled: form.get("is_recipe_controlled") === "true",
      active: form.get("active") === "true",
      updated_at: new Date().toISOString(),
    };

    if (!edit) payload.created_by = state.user.id;
    const result = edit
      ? await state.db.from("items").update(payload).eq("id", item.id)
      : await state.db.from("items").insert(payload);

    if (result.error) return toast(result.error.message, "error");
    toast("Item saved.", "ok");
    closeModal();
    renderItems();
  };
}

function openCategoryModal() {
  openModal(`
    <div class="modal-head"><h3>Add Category</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="catForm">
      <div class="modal-body"><label>Category Name</label><input name="name" class="input" required></div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Create</button></div>
    </form>
  `);
  $("catForm").onsubmit = async e => {
    e.preventDefault();
    const name = new FormData(e.target).get("name");
    const result = await state.db.from("item_categories").insert({ name });
    if (result.error) return toast(result.error.message, "error");
    toast("Category created.", "ok");
    closeModal();
    renderItems();
  };
}
