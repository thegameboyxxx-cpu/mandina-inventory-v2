import { state, canManagePurchasing } from "../state.js";
import { $, esc, showError, toast, openModal, closeModal } from "../utils.js";
import { unitSelect } from "../units.js";
import { supplierName } from "./suppliers.js";
import { loadItemDeps, loadItems } from "./items.js";

const options = (rows, selected, labelFn) => '<option value="">-- Select --</option>' + rows.map(row => (
  `<option value="${esc(row.id)}" ${row.id === selected ? "selected" : ""}>${esc(labelFn(row))}</option>`
)).join("");

const itemLabel = item => item ? `${item.name}${item.name_ar ? " / " + item.name_ar : ""}` : "";
const categoryName = id => state.categories.find(c => c.id === id)?.name || "";
const supplierLabel = id => supplierName(state.suppliers.find(s => s.id === id));
const isRawItem = item => (item?.item_type || "raw") === "raw";

function receivingUnit(item) {
  return item?.receiving_unit || item?.purchase_package_type || "";
}

function unitsPerReceiving(item) {
  return item?.purchase_package_qty ?? 1;
}

function stockUnit(item) {
  return item?.stock_unit || item?.purchase_package_unit || "";
}

function billingUnit(item) {
  return item?.cost_unit || item?.secondary_unit || item?.stock_unit || "";
}

function conversionText(item) {
  const recv = receivingUnit(item);
  const stock = stockUnit(item);
  const amount = unitsPerReceiving(item);
  if (!recv || !stock) return "";
  return `1 ${recv} = ${amount || 1} ${stock}`;
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

function itemSearchText(item) {
  return normalizeSearch([
    item.name,
    item.name_ar,
    categoryName(item.category_id),
    supplierLabel(item.primary_supplier_id),
    receivingUnit(item),
    stockUnit(item),
    billingUnit(item),
    item.purchase_package_type,
    item.purchase_package_unit,
    item.brand,
    item.acceptable_brands,
    item.sku,
    item.item_code,
  ].filter(Boolean).join(" "));
}

export async function renderItemsSimple() {
  if (!canManagePurchasing()) return $("content").innerHTML = showError("Full manager access required.");

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
            <input id="simpleItemSearch" class="input" placeholder="Search item...">
            <button class="btn" id="addSimpleItemBtn">+ Add Raw Item</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">
          Raw items are supplied items that can be purchased, received, stocked, and used as production inputs.
        </div>
        <div id="simpleItemsTable"></div>
      </div>
    `;
    $("simpleItemSearch").oninput = renderSimpleTable;
    $("addSimpleItemBtn").onclick = () => openSimpleItemModal();
    renderSimpleTable();
  } catch (e) {
    content.innerHTML = showError(e.message);
  }
}

function renderSimpleTable() {
  const terms = normalizeSearch($("simpleItemSearch")?.value || "").split(" ").filter(Boolean);
  const rows = state.items
    .filter(isRawItem)
    .filter(item => !terms.length || terms.every(term => itemSearchText(item).includes(term)));

  $("simpleItemsTable").innerHTML = `
    <table>
      <thead><tr><th>Item</th><th>Category</th><th>Supplier</th><th>Receiving Setup</th><th>Billing</th><th>Reorder</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(item => `<tr>
          <td><b>${esc(itemLabel(item))}</b></td>
          <td>${esc(categoryName(item.category_id))}</td>
          <td>${esc(supplierLabel(item.primary_supplier_id))}</td>
          <td>${esc(conversionText(item))}</td>
          <td>${esc(billingUnit(item))} ${item.default_purchase_price ? `at $${Number(item.default_purchase_price).toFixed(2)}` : ""}</td>
          <td>${item.reorder_level ?? 0} ${esc(stockUnit(item))} / order ${item.reorder_qty ?? 0} ${esc(receivingUnit(item))}</td>
          <td>${item.active === false ? '<span class="badge red">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
          <td><button class="btn secondary small edit-simple-item" data-id="${esc(item.id)}">Edit</button></td>
        </tr>`).join("") || '<tr><td colspan="8" class="muted">No raw items yet.</td></tr>'}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".edit-simple-item").forEach(button => {
    button.onclick = () => openSimpleItemModal(state.items.find(item => item.id === button.dataset.id));
  });
}

function openSimpleItemModal(item = null) {
  const edit = !!item;
  const recv = receivingUnit(item);
  const stock = stockUnit(item);
  const bill = billingUnit(item) || stock;

  openModal(`
    <div class="modal-head">
      <h3>${edit ? "Edit Raw Item" : "Add Raw Item"}</h3>
      <button class="btn secondary small" onclick="closeModal()">x</button>
    </div>
    <form id="simpleItemForm">
      <div class="modal-body">
        <div class="section-head"><h3 style="margin:0">Basic Info</h3></div>
        <div class="form-grid">
          <div><label>Item Name</label><input name="name" class="input" required value="${esc(item?.name || "")}"></div>
          <div><label>Arabic Name</label><input name="name_ar" class="input" value="${esc(item?.name_ar || "")}"></div>
          <div><label>Category</label><select name="category_id">${options(state.categories, item?.category_id, c => c.name)}</select></div>
          <div><label>Primary Supplier</label><select name="primary_supplier_id">${options(state.suppliers, item?.primary_supplier_id, supplierName)}</select></div>
          <div><label>Status</label><select name="active"><option value="true">Active</option><option value="false">Inactive</option></select></div>
          <div><label>Recipe/Sales Controlled?</label><select name="is_recipe_controlled"><option value="false">No - count report only</option><option value="true">Yes - sales variance alert</option></select></div>
        </div>

        <div class="section-head" style="margin-top:18px"><h3 style="margin:0">How We Receive and Stock It</h3></div>
        <div class="form-grid">
          <div><label>Receiving Unit</label>${unitSelect("receiving_unit", recv, "required")}<div class="muted">What arrives from the supplier, e.g. bag, box, carton, bottle.</div></div>
          <div><label>Units per Receiving Unit</label><input name="units_per_receiving" type="number" step="0.001" class="input" required value="${esc(unitsPerReceiving(item) ?? 1)}"><div class="muted">Example: if 1 bag = 5 kg, enter 5.</div></div>
          <div><label>Stock Unit</label>${unitSelect("stock_unit", stock, "required")}<div class="muted">The unit used for stock, recipes, counts, waste and sales.</div></div>
          <div><label>Preview</label><input id="conversionPreview" class="input" disabled></div>
        </div>

        <div class="section-head" style="margin-top:18px"><h3 style="margin:0">Billing</h3></div>
        <div class="form-grid">
          <div><label>Billing Unit</label>${unitSelect("cost_unit", bill, "required")}<div class="muted">The unit used on supplier invoices.</div></div>
          <div><label>Cost per Billing Unit</label><input name="default_purchase_price" type="number" step="0.01" class="input" value="${esc(item?.default_purchase_price ?? "")}"></div>
        </div>

        <div class="section-head" style="margin-top:18px"><h3 style="margin:0">Inventory Control</h3></div>
        <div class="form-grid">
          <div><label>Reorder Level</label><input name="reorder_level" type="number" step="0.001" class="input" value="${esc(item?.reorder_level ?? "")}"><div class="muted">Based on Stock Unit.</div></div>
          <div><label>Reorder Qty</label><input name="reorder_qty" type="number" step="0.001" class="input" value="${esc(item?.reorder_qty ?? "")}"><div class="muted">Based on Receiving Unit.</div></div>
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

  const updatePreview = () => {
    const recvUnit = document.querySelector("[name='receiving_unit']").value || "?";
    const amount = document.querySelector("[name='units_per_receiving']").value || "1";
    const stockUnitValue = document.querySelector("[name='stock_unit']").value || "?";
    $("conversionPreview").value = `1 ${recvUnit} = ${amount} ${stockUnitValue}`;
  };

  ["receiving_unit", "units_per_receiving", "stock_unit"].forEach(name => {
    document.querySelector(`[name='${name}']`).oninput = updatePreview;
    document.querySelector(`[name='${name}']`).onchange = updatePreview;
  });
  updatePreview();

  $("simpleItemForm").onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    const numberOrNull = key => form.get(key) === "" ? null : Number(form.get(key));
    const receiving = form.get("receiving_unit");
    const stockUnitValue = form.get("stock_unit");
    const costUnit = form.get("cost_unit");

    const payload = {
      name: form.get("name"),
      name_ar: form.get("name_ar") || null,
      category_id: form.get("category_id") || null,
      primary_supplier_id: form.get("primary_supplier_id") || null,
      item_type: "raw",
      receiving_unit: receiving,
      purchase_package_type: receiving,
      purchase_package_qty: Number(form.get("units_per_receiving") || 1),
      purchase_package_unit: stockUnitValue,
      stock_unit: stockUnitValue,
      cost_unit: costUnit,
      has_dual_unit: costUnit !== stockUnitValue,
      secondary_unit: costUnit !== stockUnitValue ? costUnit : null,
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
    toast("Raw item saved.", "ok");
    closeModal();
    renderItemsSimple();
  };
}
