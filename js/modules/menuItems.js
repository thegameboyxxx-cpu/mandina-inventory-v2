import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { unitOptions } from "../units.js";
import { safeSelect, insertRow, updateRow, deleteRows } from "../services/db.js";
import { loadItems } from "./items.js";

let menuItems = [];
let components = [];
let filters = { search: "", status: "" };

const itemLabel = item => item ? `${item.name}${item.name_ar ? " / " + item.name_ar : ""}` : "Item";
const stockItem = id => (state.items || []).find(i => i.id === id);
const menuName = item => item ? `${item.name}${item.name_ar ? " / " + item.name_ar : ""}` : "Menu Item";
const activeMenu = item => item?.active !== false;

async function loadMenuData() {
  await loadItems();
  menuItems = await safeSelect("menu_items", "*", { order: "name" }).catch(() => []);
  components = await safeSelect("menu_item_components", "*", { order: "sort_order" }).catch(() => []);
}

export async function renderMenuItems() {
  if (!isManager()) return $("content").innerHTML = showError("Staff users cannot access Menu Items.");

  const content = $("content");
  content.innerHTML = '<div class="card">Loading menu items...</div>';

  try {
    await loadMenuData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Menu Items</h2>
          <div class="toolbar">
            <input id="menuSearch" class="input" placeholder="Search menu item...">
            <select id="menuStatusFilter">
              <option value="">All status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <button class="btn" id="addMenuItemBtn">+ Add Menu Item</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">
          Menu items are what customers buy. Deduction lines define which stock items are reduced when one menu item is sold.
        </div>
        <div id="menuItemsTable"></div>
      </div>
    `;

    $("menuSearch").value = filters.search;
    $("menuStatusFilter").value = filters.status;
    $("menuSearch").oninput = e => { filters.search = e.target.value; renderMenuTable(); };
    $("menuStatusFilter").onchange = e => { filters.status = e.target.value; renderMenuTable(); };
    $("addMenuItemBtn").onclick = () => openMenuItemModal();
    renderMenuTable();
  } catch (e) {
    content.innerHTML = showError("Could not load Menu Items. " + e.message);
  }
}

function componentsFor(menuItemId) {
  return components
    .filter(c => c.menu_item_id === menuItemId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
}

function renderMenuTable() {
  const q = filters.search.toLowerCase();
  const rows = menuItems
    .filter(item => !filters.status || (filters.status === "active" ? activeMenu(item) : !activeMenu(item)))
    .filter(item => !q || JSON.stringify({ ...item, components: componentsFor(item.id).map(c => itemLabel(stockItem(c.item_id))) }).toLowerCase().includes(q));

  $("menuItemsTable").innerHTML = `
    <table>
      <thead><tr><th>Menu Item</th><th>Category</th><th>Price</th><th>Deductions</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(item => {
          const lines = componentsFor(item.id);
          return `<tr>
            <td><b>${esc(menuName(item))}</b></td>
            <td>${esc(item.category || "")}</td>
            <td>${money(item.sale_price || 0)}</td>
            <td>${lines.length ? lines.slice(0, 3).map(line => {
              const si = stockItem(line.item_id);
              return `<div>${esc(itemLabel(si))}: ${qty(line.qty_per_portion || 0)} ${esc(line.unit || si?.stock_unit || "")}</div>`;
            }).join("") + (lines.length > 3 ? `<div class="muted">+${lines.length - 3} more</div>` : "") : '<span class="badge red">No deductions</span>'}</td>
            <td>${activeMenu(item) ? '<span class="badge green">Active</span>' : '<span class="badge red">Inactive</span>'}</td>
            <td><button class="btn secondary small edit-menu-item" data-id="${esc(item.id)}">Open</button></td>
          </tr>`;
        }).join("") || '<tr><td colspan="6" class="muted">No menu items yet.</td></tr>'}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".edit-menu-item").forEach(btn => {
    btn.onclick = () => openMenuItemModal(menuItems.find(item => item.id === btn.dataset.id));
  });
}

function blankComponent() {
  return { item_id: "", qty_per_portion: 1, unit: "", sort_order: 0 };
}

function stockItemOptions(selected) {
  const rows = (state.items || []).filter(item => item.active !== false || item.id === selected);
  return '<option value="">-- Select stock item --</option>' + rows.map(item => (
    `<option value="${esc(item.id)}" ${item.id === selected ? "selected" : ""}>${esc(itemLabel(item))}${item.item_type === "produced" ? " (produced)" : ""}</option>`
  )).join("");
}

function openMenuItemModal(menuItem = null) {
  const edit = !!menuItem;
  let localComponents = edit
    ? componentsFor(menuItem.id).map(c => ({ ...c }))
    : [blankComponent()];

  openModal(`
    <div class="modal-head">
      <h3>${edit ? "Edit Menu Item" : "Add Menu Item"}</h3>
      <button class="btn secondary small" onclick="closeModal()">x</button>
    </div>
    <form id="menuItemForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Menu Item Name</label><input name="name" class="input" required value="${esc(menuItem?.name || "")}"></div>
          <div><label>Arabic Name</label><input name="name_ar" class="input" value="${esc(menuItem?.name_ar || "")}"></div>
          <div><label>Category</label><input name="category" class="input" value="${esc(menuItem?.category || "")}" placeholder="Mandi, Drinks, Deals..."></div>
          <div><label>Sale Price</label><input name="sale_price" type="number" step="0.01" class="input" value="${esc(menuItem?.sale_price ?? 0)}"></div>
          <div><label>Status</label><select name="active"><option value="true">Active</option><option value="false">Inactive</option></select></div>
        </div>

        <div class="section-head" style="margin-top:18px">
          <h3 style="margin:0">Stock Deductions Per Sale</h3>
          <button type="button" class="btn secondary small" id="addComponentBtn">+ Add Deduction</button>
        </div>
        <div class="muted" style="margin-bottom:10px">
          Add every stock item reduced when this menu item is sold. This can be produced food, raw/direct-sale drinks, packaging, sauces, or fill-up stock.
        </div>
        <div id="componentsBox"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn">Save</button>
      </div>
    </form>
  `);

  if (menuItem?.active === false) document.querySelector("[name='active']").value = "false";

  function renderComponents() {
    $("componentsBox").innerHTML = `
      <table>
        <thead><tr><th>Stock Item</th><th>Qty Deducted</th><th>Unit</th><th></th></tr></thead>
        <tbody>
          ${localComponents.map((line, idx) => {
            const si = stockItem(line.item_id);
            return `<tr>
              <td><select class="component-item" data-idx="${idx}" style="min-width:260px">${stockItemOptions(line.item_id)}</select></td>
              <td><input class="input component-qty" data-idx="${idx}" type="number" step="0.001" value="${esc(line.qty_per_portion ?? "")}"></td>
              <td><select class="component-unit" data-idx="${idx}">${unitOptions(line.unit || si?.stock_unit || "")}</select></td>
              <td><button type="button" class="btn red small remove-component" data-idx="${idx}">x</button></td>
            </tr>`;
          }).join("") || '<tr><td colspan="4" class="muted">No deduction lines.</td></tr>'}
        </tbody>
      </table>
    `;
    bindComponentEvents();
  }

  function bindComponentEvents() {
    document.querySelectorAll(".component-item").forEach(el => el.onchange = e => {
      const idx = Number(e.target.dataset.idx);
      const si = stockItem(e.target.value);
      localComponents[idx].item_id = e.target.value;
      localComponents[idx].unit = si?.stock_unit || "";
      renderComponents();
    });
    document.querySelectorAll(".component-qty").forEach(el => el.oninput = e => {
      localComponents[Number(e.target.dataset.idx)].qty_per_portion = Number(e.target.value || 0);
    });
    document.querySelectorAll(".component-unit").forEach(el => el.onchange = e => {
      localComponents[Number(e.target.dataset.idx)].unit = e.target.value;
    });
    document.querySelectorAll(".remove-component").forEach(el => el.onclick = e => {
      localComponents.splice(Number(e.target.dataset.idx), 1);
      renderComponents();
    });
  }

  renderComponents();
  $("addComponentBtn").onclick = () => {
    localComponents.push(blankComponent());
    renderComponents();
  };

  $("menuItemForm").onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = {
      name: form.get("name"),
      name_ar: form.get("name_ar") || null,
      category: form.get("category") || null,
      sale_price: Number(form.get("sale_price") || 0),
      active: form.get("active") === "true",
      updated_at: new Date().toISOString(),
    };
    if (!edit) payload.created_by = state.user.id;

    const cleanComponents = localComponents
      .filter(line => line.item_id && Number(line.qty_per_portion || 0) > 0)
      .map((line, idx) => {
        const si = stockItem(line.item_id);
        return {
          item_id: line.item_id,
          qty_per_portion: Number(line.qty_per_portion || 0),
          unit: line.unit || si?.stock_unit || "",
          sort_order: idx,
        };
      });

    try {
      const saved = edit
        ? await updateRow("menu_items", menuItem.id, payload)
        : await insertRow("menu_items", payload);

      await deleteRows("menu_item_components", "menu_item_id", saved.id);
      if (cleanComponents.length) {
        const { error } = await state.db.from("menu_item_components").insert(cleanComponents.map(line => ({ ...line, menu_item_id: saved.id })));
        if (error) throw error;
      }

      toast("Menu item saved.", "ok");
      closeModal();
      renderMenuItems();
    } catch (err) {
      toast("Menu item save failed: " + err.message, "error");
    }
  };
}
