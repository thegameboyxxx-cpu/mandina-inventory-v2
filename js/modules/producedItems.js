import { state, canManagePurchasing } from "../state.js";
import { $, esc, showError, toast, openModal, closeModal } from "../utils.js";
import { unitSelect } from "../units.js";
import { loadItemDeps, loadItems } from "./items.js";

const options = (rows, selected, labelFn) => '<option value="">-- Select --</option>' + rows.map(row => (
  `<option value="${esc(row.id)}" ${row.id === selected ? "selected" : ""}>${esc(labelFn(row))}</option>`
)).join("");

const itemLabel = item => item ? `${item.name}${item.name_ar ? " / " + item.name_ar : ""}` : "";
const categoryName = id => state.categories.find(c => c.id === id)?.name || "";
const isProducedItem = item => item?.item_type === "produced";
const productionKind = item => item?.production_kind || "food_production";
const productionKindLabel = value => value === "fill_up" ? "Fill Up" : "Food Production";

export async function renderProducedItems() {
  if (!canManagePurchasing()) return $("content").innerHTML = showError("Full manager access required.");

  const content = $("content");
  content.innerHTML = '<div class="card">Loading produced items...</div>';

  try {
    await loadItemDeps();
    await loadItems();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Produced Items</h2>
          <div class="toolbar">
            <input id="producedItemSearch" class="input" placeholder="Search produced item...">
            <button class="btn" id="addProducedItemBtn">+ Add Produced Item</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">
          Produced items are made by recipes. They are not purchased or received from suppliers.
        </div>
        <div id="producedItemsTable"></div>
      </div>
    `;
    $("producedItemSearch").oninput = renderProducedTable;
    $("addProducedItemBtn").onclick = () => openProducedItemModal();
    renderProducedTable();
  } catch (e) {
    content.innerHTML = showError(e.message);
  }
}

function renderProducedTable() {
  const q = ($("producedItemSearch")?.value || "").toLowerCase();
  const rows = state.items
    .filter(isProducedItem)
    .filter(item => JSON.stringify(item).toLowerCase().includes(q));

  $("producedItemsTable").innerHTML = `
    <table>
      <thead><tr><th>Produced Item</th><th>Production Type</th><th>Category</th><th>Stock Unit</th><th>Minimum Level</th><th>Recipe/Sales Control</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(item => `<tr>
          <td><b>${esc(itemLabel(item))}</b></td>
          <td>${esc(productionKindLabel(productionKind(item)))}</td>
          <td>${esc(categoryName(item.category_id))}</td>
          <td>${esc(item.stock_unit || "")}</td>
          <td>${item.reorder_level ?? 0} ${esc(item.stock_unit || "")}</td>
          <td>${item.is_recipe_controlled ? '<span class="badge green">Yes</span>' : '<span class="badge gold">Count only</span>'}</td>
          <td>${item.active === false ? '<span class="badge red">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
          <td><button class="btn secondary small edit-produced-item" data-id="${esc(item.id)}">Edit</button></td>
        </tr>`).join("") || '<tr><td colspan="8" class="muted">No produced items yet.</td></tr>'}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".edit-produced-item").forEach(button => {
    button.onclick = () => openProducedItemModal(state.items.find(item => item.id === button.dataset.id));
  });
}

function openProducedItemModal(item = null) {
  const edit = !!item;

  openModal(`
    <div class="modal-head">
      <h3>${edit ? "Edit Produced Item" : "Add Produced Item"}</h3>
      <button class="btn secondary small" onclick="closeModal()">x</button>
    </div>
    <form id="producedItemForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Item Name</label><input name="name" class="input" required value="${esc(item?.name || "")}"></div>
          <div><label>Arabic Name</label><input name="name_ar" class="input" value="${esc(item?.name_ar || "")}"></div>
          <div><label>Production Type</label><select name="production_kind"><option value="food_production">Food Production</option><option value="fill_up">Fill Up</option></select><div class="muted">Used to filter production runs.</div></div>
          <div><label>Category</label><select name="category_id">${options(state.categories, item?.category_id, c => c.name)}</select></div>
          <div><label>Stock Unit</label>${unitSelect("stock_unit", item?.stock_unit || "", "required")}<div class="muted">Used for stock, recipes, counts, waste and sales.</div></div>
          <div><label>Minimum Stock Level</label><input name="reorder_level" type="number" step="0.001" class="input" value="${esc(item?.reorder_level ?? "")}"><div class="muted">Optional alert level for prepared stock.</div></div>
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

  if (item?.active === false) document.querySelector("[name='active']").value = "false";
  if (item?.is_recipe_controlled) document.querySelector("[name='is_recipe_controlled']").value = "true";
  document.querySelector("[name='production_kind']").value = productionKind(item);

  $("producedItemForm").onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    const numberOrNull = key => form.get(key) === "" ? null : Number(form.get(key));
    const stockUnit = form.get("stock_unit");
    const payload = {
      name: form.get("name"),
      name_ar: form.get("name_ar") || null,
      category_id: form.get("category_id") || null,
      primary_supplier_id: null,
      item_type: "produced",
      production_kind: form.get("production_kind") || "food_production",
      receiving_unit: null,
      purchase_package_type: null,
      purchase_package_qty: 1,
      purchase_package_unit: stockUnit,
      stock_unit: stockUnit,
      cost_unit: null,
      has_dual_unit: false,
      secondary_unit: null,
      reorder_level: numberOrNull("reorder_level"),
      reorder_qty: null,
      default_purchase_price: null,
      is_recipe_controlled: form.get("is_recipe_controlled") === "true",
      active: form.get("active") === "true",
      updated_at: new Date().toISOString(),
    };

    if (!edit) payload.created_by = state.user.id;
    const result = edit
      ? await state.db.from("items").update(payload).eq("id", item.id)
      : await state.db.from("items").insert(payload);

    if (result.error) return toast(result.error.message, "error");
    toast("Produced item saved.", "ok");
    closeModal();
    renderProducedItems();
  };
}
