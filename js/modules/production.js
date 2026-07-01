import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { unitOptions, unitSelect } from "../units.js";
import { safeSelect, insertRow, updateRow, deleteRows } from "../services/db.js";
import { loadItems, loadItemDeps } from "./items.js";

let recipes = [];
let recipeInputs = [];
let batches = [];
let stockBalances = [];
let batchMovements = [];
let filters = { search: "", recipe_id: "", status: "" };

const same = (a, b) => String(a || "").toLowerCase().trim() === String(b || "").toLowerCase().trim();
const today = () => new Date().toISOString().slice(0, 10);
const item = id => (state.items || []).find(i => i.id === id);
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";
const recipeName = r => r?.name || `Recipe-${String(r?.id || "").slice(0, 8)}`;
const batchNo = b => b?.batch_number || `PB-${String(b?.id || "").slice(0, 8)}`;
const inputQty = x => Number(x.qty_per_base ?? x.qty ?? 0);
const activeRecipe = r => r?.is_active !== false && r?.active !== false;

function branchName() {
  const b = (state.branches || []).find(x => x.id === state.currentBranchId) || {};
  return b.name || b.branch_name || b.title || state.currentBranchId || "";
}

function stockQty(itemId) {
  const b = stockBalances.find(x => x.item_id === itemId);
  return Number(b?.qty_on_hand ?? b?.current_qty ?? b?.quantity ?? 0);
}

function stockText(itemId) {
  const it = item(itemId);
  return `${qty(stockQty(itemId))} ${it?.stock_unit || ""}`;
}

function outputUnitForItem(it) {
  return it?.stock_unit || it?.receiving_unit || it?.purchase_package_unit || "";
}

function recipeInputsFor(recipeId) {
  return recipeInputs.filter(x => x.recipe_id === recipeId).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
}

function scalingInputFor(recipe) {
  const inputs = recipeInputsFor(recipe.id);
  return inputs.find(x => x.is_scaling_base) || inputs.find(x => x.item_id === recipe.batch_main_input_item_id) || null;
}

function recipeOutputQty(recipe) {
  return Number(recipe.output_qty || 0);
}

function calcScale(recipe, mainInputUsed, actualOutput) {
  const scaleInput = scalingInputFor(recipe);
  if (scaleInput) {
    const base = Number(recipe.batch_main_input_qty || inputQty(scaleInput) || 0);
    return base > 0 ? Number(mainInputUsed || 0) / base : 1;
  }
  const outputBase = recipeOutputQty(recipe);
  return outputBase > 0 ? Number(actualOutput || 0) / outputBase : 1;
}

function requiredInputs(recipe, scale) {
  return recipeInputsFor(recipe.id).map(x => ({
    ...x,
    item: item(x.item_id),
    required_qty: Number(inputQty(x) || 0) * Number(scale || 0),
    unit: x.unit || item(x.item_id)?.stock_unit || "",
  }));
}

function unitErrors(lines, outputItem, outputUnit) {
  const errors = [];
  for (const line of lines) {
    const it = line.item;
    if (!it) continue;
    if (!same(line.unit, it.stock_unit)) {
      errors.push(`${itemLabel(it)} uses ${line.unit || "-"} but stock unit is ${it.stock_unit || "-"}. Add a conversion before using this unit.`);
    }
  }
  if (outputItem && outputUnit && !same(outputUnit, outputItem.stock_unit)) {
    errors.push(`${itemLabel(outputItem)} output unit is ${outputUnit}, but stock unit is ${outputItem.stock_unit}.`);
  }
  return errors;
}

async function loadProductionData() {
  await loadItemDeps();
  await loadItems();

  recipes = await safeSelect("production_recipes", "*", { order: "created_at", ascending: false }).catch(() => []);
  recipeInputs = await safeSelect("production_recipe_inputs", "*", { order: "sort_order" }).catch(() => []);
  batches = await safeSelect("production_batches", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
  stockBalances = await safeSelect("stock_balances", "*", { eq: { branch_id: state.currentBranchId } }).catch(() => []);
  batchMovements = await safeSelect("stock_movements", "*", { eq: { branch_id: state.currentBranchId, reference_type: "production" }, order: "created_at", ascending: false }).catch(() => []);
}

export async function renderProduction() {
  const c = $("content");
  c.innerHTML = `<div class="card">Loading production...</div>`;

  try {
    await loadProductionData();
    c.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Production</h2>
          <div class="toolbar">
            <input id="prodSearch" class="input" placeholder="Search recipes or batches...">
            <select id="prodRecipeFilter"><option value="">All recipes</option>${recipes.map(r => `<option value="${esc(r.id)}">${esc(recipeName(r))}</option>`).join("")}</select>
            <select id="prodStatusFilter"><option value="">All status</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>
            ${isManager() ? `<button class="btn secondary" id="newRecipeBtn">+ Recipe Setup</button>` : ""}
            <button class="btn" id="newBatchBtn">+ Production Run</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">
          Branch: <b>${esc(branchName())}</b>. Production deducts input stock and adds prepared output stock through stock movements.
        </div>
        <div id="productionDashboard"></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Production Recipes</h2></div>
        <div id="recipesTable"></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Production History</h2></div>
        <div id="batchesTable"></div>
      </div>
    `;

    $("prodSearch").value = filters.search;
    $("prodRecipeFilter").value = filters.recipe_id;
    $("prodStatusFilter").value = filters.status;
    $("prodSearch").oninput = e => { filters.search = e.target.value; renderProductionTables(); };
    $("prodRecipeFilter").onchange = e => { filters.recipe_id = e.target.value; renderProductionTables(); };
    $("prodStatusFilter").onchange = e => { filters.status = e.target.value; renderProductionTables(); };
    if ($("newRecipeBtn")) $("newRecipeBtn").onclick = () => openRecipeModal();
    $("newBatchBtn").onclick = () => openBatchModal();

    renderProductionTables();
  } catch (e) {
    c.innerHTML = showError("Could not load Production. " + e.message);
  }
}

function renderProductionTables() {
  const q = filters.search.toLowerCase();
  const recipeRows = recipes.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  const batchRows = batches.filter(b =>
    (!filters.recipe_id || b.recipe_id === filters.recipe_id) &&
    (!filters.status || (b.status || "completed") === filters.status) &&
    JSON.stringify(b).toLowerCase().includes(q)
  );

  const completed = batches.filter(b => (b.status || "completed") === "completed");
  const cancelled = batches.filter(b => b.status === "cancelled");
  const wasteQty = batchMovements.filter(m => m.movement_type === "WASTE").reduce((s, m) => s + Math.abs(Number(m.qty_change || 0)), 0);

  $("productionDashboard").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Active Recipes</div><div><b>${recipes.filter(activeRecipe).length}</b></div></div>
      <div class="card"><div class="stat-title">Completed Batches</div><div><b>${completed.length}</b></div></div>
      <div class="card"><div class="stat-title">Cancelled</div><div><b>${cancelled.length}</b></div></div>
      <div class="card"><div class="stat-title">Recorded Waste</div><div><b>${qty(wasteQty)}</b></div></div>
    </div>
  `;

  $("recipesTable").innerHTML = `
    <table>
      <thead><tr><th>Recipe</th><th>Output Item</th><th>Standard Output</th><th>Scaling Base</th><th>Inputs</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${recipeRows.map(r => {
          const out = item(r.output_item_id);
          const scale = scalingInputFor(r);
          const scaleItem = item(scale?.item_id || r.batch_main_input_item_id);
          const inputs = recipeInputsFor(r.id);
          return `<tr>
            <td><b>${esc(recipeName(r))}</b><div class="muted">${esc(r.notes || "")}</div></td>
            <td>${esc(itemLabel(out))}</td>
            <td>${qty(r.output_qty || 0)} ${esc(r.output_unit || outputUnitForItem(out))}</td>
            <td>${scaleItem ? `${esc(itemLabel(scaleItem))} (${qty(r.batch_main_input_qty || inputQty(scale))})` : "-"}</td>
            <td>${inputs.length}</td>
            <td>${activeRecipe(r) ? `<span class="badge green">Active</span>` : `<span class="badge red">Inactive</span>`}</td>
            <td>
              ${isManager() ? `<button class="btn secondary small edit-recipe" data-id="${esc(r.id)}">Open</button>` : ""}
              ${activeRecipe(r) ? `<button class="btn small make-batch" data-id="${esc(r.id)}">Produce</button>` : ""}
            </td>
          </tr>`;
        }).join("") || '<tr><td colspan="7" class="muted">No recipes yet.</td></tr>'}
      </tbody>
    </table>
  `;

  $("batchesTable").innerHTML = `
    <table>
      <thead><tr><th>Batch</th><th>Date</th><th>Recipe</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${batchRows.map(b => {
          const r = recipes.find(x => x.id === b.recipe_id);
          const out = item(b.output_item_id);
          const expected = Number(b.planned_output_qty ?? b.scaled_output_qty ?? 0);
          const actual = Number(b.actual_output_qty || 0);
          const variance = actual - expected;
          return `<tr>
            <td><b>${esc(batchNo(b))}</b><div class="muted">${esc(b.notes || "")}</div></td>
            <td>${esc((b.production_date || b.batch_date || b.created_at || "").slice(0, 10))}</td>
            <td>${esc(recipeName(r))}</td>
            <td>${qty(expected)} ${esc(b.output_unit || outputUnitForItem(out))}</td>
            <td>${qty(actual)} ${esc(b.output_unit || outputUnitForItem(out))}</td>
            <td><span class="badge ${variance < 0 ? "red" : variance > 0 ? "gold" : "green"}">${qty(variance)}</span></td>
            <td><span class="badge ${b.status === "cancelled" ? "red" : "green"}">${esc(b.status || "completed")}</span></td>
            <td>
              <button class="btn secondary small view-batch" data-id="${esc(b.id)}">View</button>
              ${isManager() && (b.status || "completed") === "completed" ? `<button class="btn red small cancel-batch" data-id="${esc(b.id)}">Cancel</button>` : ""}
            </td>
          </tr>`;
        }).join("") || '<tr><td colspan="8" class="muted">No production batches yet.</td></tr>'}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".edit-recipe").forEach(btn => btn.onclick = () => openRecipeModal(recipes.find(r => r.id === btn.dataset.id)));
  document.querySelectorAll(".make-batch").forEach(btn => btn.onclick = () => openBatchModal(recipes.find(r => r.id === btn.dataset.id)));
  document.querySelectorAll(".view-batch").forEach(btn => btn.onclick = () => openBatchDetails(batches.find(b => b.id === btn.dataset.id)));
  document.querySelectorAll(".cancel-batch").forEach(btn => btn.onclick = () => openCancelBatchModal(batches.find(b => b.id === btn.dataset.id)));
}

function blankInputLine() {
  return { item_id: "", qty: 0, qty_per_base: 0, unit: "", is_scaling_base: false, notes: "" };
}

function inputFromItem(it) {
  return { item_id: it.id, qty: 1, qty_per_base: 1, unit: it.stock_unit || "", is_scaling_base: false, notes: "" };
}

function optionItems(selected, rows = state.items) {
  return `<option value="">-- Select --</option>${rows.filter(i => i.active !== false || i.id === selected).map(i => `<option value="${esc(i.id)}" ${i.id === selected ? "selected" : ""}>${esc(itemLabel(i))}</option>`).join("")}`;
}

function producedOutputItems(selected) {
  const rows = (state.items || []).filter(i => i.item_type === "produced" || i.id === selected);
  return optionItems(selected, rows);
}

function validateRecipePayload(outputItemId, outputQty, outputUnit, lines) {
  if (!outputItemId) return "Select an output item.";
  if (Number(outputQty || 0) <= 0) return "Standard output quantity must be greater than zero.";
  if (!outputUnit) return "Output unit is required.";
  const clean = lines.filter(x => x.item_id);
  if (!clean.length) return "Add at least one recipe input.";
  for (const line of clean) {
    if (Number(inputQty(line) || 0) <= 0) return "Every input must have a quantity greater than zero.";
    if (!line.unit) return "Every input must have a unit.";
    const it = item(line.item_id);
    if (it && !same(line.unit, it.stock_unit)) return `${itemLabel(it)} must use stock unit ${it.stock_unit}. Unit conversions are not configured yet.`;
  }
  return "";
}

function openRecipeModal(recipe = null) {
  if (!isManager()) return toast("Only managers can edit recipes.", "error");
  const isEdit = !!recipe;
  const localInputs = isEdit
    ? recipeInputsFor(recipe.id).map(x => ({ ...x, qty: inputQty(x), qty_per_base: inputQty(x) }))
    : [blankInputLine()];

  const producedRows = (state.items || []).filter(i => i.active !== false && i.item_type === "produced");
  openModal(`
    <div class="modal-head"><h3>${isEdit ? "Production Recipe" : "New Production Recipe"}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="recipeForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Recipe Name</label><input name="name" class="input" required value="${esc(recipe?.name || "")}" placeholder="Mandi Rice"></div>
          <div><label>Arabic Name</label><input name="name_ar" class="input" value="${esc(recipe?.name_ar || "")}"></div>
          <div><label>Output Produced Item</label><select name="output_item_id" required>${producedOutputItems(recipe?.output_item_id)}</select><div class="muted">${producedRows.length ? "Only produced items appear here." : "Create a produced item first from Produced Items."}</div></div>
          <div><label>Standard Output Qty</label><input name="output_qty" type="number" step="0.001" class="input" required value="${esc(recipe?.output_qty ?? 1)}"></div>
          <div><label>Output Unit</label>${unitSelect("output_unit", recipe?.output_unit || outputUnitForItem(item(recipe?.output_item_id)) || "", "required")}</div>
          <div><label>Status</label><select name="is_active"><option value="true">Active</option><option value="false">Inactive</option></select></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2">${esc(recipe?.notes || "")}</textarea></div>
        </div>

        <div class="section-head" style="margin-top:16px">
          <h3 style="margin:0">Recipe Inputs</h3>
          <button type="button" class="btn secondary small" id="addRecipeInputBtn">+ Add Input</button>
        </div>
        <div class="muted" style="margin:8px 0">Mark one input as Scaling Base when production should scale from that item, e.g. 5 kg rice gives 40 plates.</div>
        <div id="recipeInputsBox"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn">Save Recipe</button>
      </div>
    </form>
  `);
  document.querySelector("[name='is_active']").value = activeRecipe(recipe) ? "true" : "false";
  document.querySelector("[name='output_item_id']").onchange = e => {
    const out = item(e.target.value);
    document.querySelector("[name='output_unit']").value = outputUnitForItem(out);
  };

  function renderInputLines() {
    $("recipeInputsBox").innerHTML = `
      <table>
        <thead><tr><th>Input Item</th><th>Qty</th><th>Unit</th><th>Scaling Base</th><th>Current Stock</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${localInputs.map((line, idx) => {
            const it = item(line.item_id);
            return `<tr>
              <td><select class="recipe-input-item" data-idx="${idx}">${optionItems(line.item_id)}</select></td>
              <td><input type="number" step="0.001" class="input recipe-input-qty" data-idx="${idx}" value="${esc(inputQty(line) || "")}"></td>
              <td><select class="recipe-input-unit" data-idx="${idx}">${unitOptions(line.unit || it?.stock_unit || "")}</select></td>
              <td><input type="radio" name="scaling_base" class="recipe-scale-base" data-idx="${idx}" ${line.is_scaling_base ? "checked" : ""}></td>
              <td class="muted">${it ? esc(stockText(it.id)) : ""}</td>
              <td><input class="input recipe-input-note" data-idx="${idx}" value="${esc(line.notes || "")}"></td>
              <td><button type="button" class="btn red small remove-recipe-line" data-idx="${idx}">x</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
    bindInputLineEvents();
  }

  function bindInputLineEvents() {
    document.querySelectorAll(".recipe-input-item").forEach(el => el.onchange = e => {
      const idx = Number(e.target.dataset.idx);
      const it = item(e.target.value);
      localInputs[idx] = it ? { ...localInputs[idx], ...inputFromItem(it) } : blankInputLine();
      renderInputLines();
    });
    document.querySelectorAll(".recipe-input-qty").forEach(el => el.oninput = e => {
      localInputs[Number(e.target.dataset.idx)].qty = Number(e.target.value || 0);
      localInputs[Number(e.target.dataset.idx)].qty_per_base = Number(e.target.value || 0);
    });
    document.querySelectorAll(".recipe-input-unit").forEach(el => el.oninput = e => localInputs[Number(e.target.dataset.idx)].unit = e.target.value);
    document.querySelectorAll(".recipe-input-note").forEach(el => el.oninput = e => localInputs[Number(e.target.dataset.idx)].notes = e.target.value);
    document.querySelectorAll(".recipe-scale-base").forEach(el => el.onchange = e => {
      localInputs.forEach(x => x.is_scaling_base = false);
      localInputs[Number(e.target.dataset.idx)].is_scaling_base = true;
    });
    document.querySelectorAll(".remove-recipe-line").forEach(el => el.onclick = e => {
      localInputs.splice(Number(e.target.dataset.idx), 1);
      if (!localInputs.length) localInputs.push(blankInputLine());
      renderInputLines();
    });
  }

  renderInputLines();
  $("addRecipeInputBtn").onclick = () => { localInputs.push(blankInputLine()); renderInputLines(); };

  $("recipeForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const outputIt = item(fd.get("output_item_id"));
    const outputUnit = fd.get("output_unit") || outputUnitForItem(outputIt);
    const validation = validateRecipePayload(fd.get("output_item_id"), fd.get("output_qty"), outputUnit, localInputs);
    if (validation) return toast(validation, "error");

    const cleanInputs = localInputs.filter(x => x.item_id && Number(inputQty(x) || 0) > 0);
    const scaleBase = cleanInputs.find(x => x.is_scaling_base);
    const baseQty = scaleBase ? Number(inputQty(scaleBase) || 1) : 1;
    const payload = {
      name: fd.get("name"),
      name_ar: fd.get("name_ar") || null,
      output_item_id: fd.get("output_item_id"),
      output_qty: Number(fd.get("output_qty") || 0),
      output_unit: outputUnit,
      base_input_item_id: scaleBase?.item_id || null,
      base_input_qty: baseQty,
      batch_main_input_item_id: scaleBase?.item_id || null,
      batch_main_input_qty: baseQty,
      active: fd.get("is_active") === "true",
      is_active: fd.get("is_active") === "true",
      notes: fd.get("notes") || null,
      updated_at: new Date().toISOString(),
    };

    try {
      let saved;
      if (isEdit) saved = await updateRow("production_recipes", recipe.id, payload);
      else saved = await insertRow("production_recipes", { ...payload, created_by: state.user.id });

      await deleteRows("production_recipe_inputs", "recipe_id", saved.id);
      const rows = cleanInputs.map((x, idx) => ({
        recipe_id: saved.id,
        item_id: x.item_id,
        qty_per_base: Number(inputQty(x) || 0),
        qty: Number(inputQty(x) || 0),
        unit: x.unit || item(x.item_id)?.stock_unit || "",
        is_scaling_base: !!x.is_scaling_base,
        notes: x.notes || null,
        sort_order: idx,
      }));

      const { error } = await state.db.from("production_recipe_inputs").insert(rows);
      if (error) throw error;
      toast("Production recipe saved.", "ok");
      closeModal();
      renderProduction();
    } catch (err) {
      toast("Recipe save failed: " + err.message, "error");
    }
  };
}

function openBatchModal(recipe = null) {
  const activeRecipes = recipes.filter(activeRecipe);
  const selected = recipe || activeRecipes[0];
  if (!activeRecipes.length) return toast("Create an active recipe first.", "error");

  openModal(`
    <div class="modal-head"><h3>Production Run</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="batchForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Branch</label><input class="input" value="${esc(branchName())}" disabled></div>
          <div><label>Production Date</label><input name="production_date" type="date" class="input" value="${today()}"></div>
          <div><label>Recipe</label><select name="recipe_id" id="batchRecipeSelect">${activeRecipes.map(r => `<option value="${esc(r.id)}" ${r.id === selected?.id ? "selected" : ""}>${esc(recipeName(r))}</option>`).join("")}</select></div>
          <div id="mainInputWrap"><label>Main Input Used</label><input name="main_input_qty" id="mainInputQty" type="number" step="0.001" class="input"></div>
          <div><label>Actual Output Qty</label><input name="actual_output_qty" id="actualOutputQty" type="number" step="0.001" class="input"></div>
          <div><label>Waste/Loss Qty</label><input name="waste_qty" id="wasteQty" type="number" step="0.001" class="input" value="0"></div>
          ${isManager() ? `<div><label><input type="checkbox" name="allow_negative" style="width:auto"> Allow negative stock override</label></div>` : ""}
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
        <div id="batchPreview" style="margin-top:16px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn green">Complete Production</button>
      </div>
    </form>
  `);

  function selectedRecipe() {
    return recipes.find(r => r.id === $("batchRecipeSelect").value);
  }

  function values() {
    const r = selectedRecipe();
    const scaleInput = r ? scalingInputFor(r) : null;
    const actualOutput = Number($("actualOutputQty").value || 0);
    const mainUsed = scaleInput ? Number($("mainInputQty").value || 0) : 0;
    const scale = r ? calcScale(r, mainUsed, actualOutput) : 1;
    const expectedOutput = Number(r?.output_qty || 0) * scale;
    const waste = Number($("wasteQty").value || 0);
    return { r, scaleInput, actualOutput, mainUsed, scale, expectedOutput, waste };
  }

  function renderPreview() {
    const { r, scaleInput, actualOutput, mainUsed, scale, expectedOutput, waste } = values();
    if (!r) return $("batchPreview").innerHTML = `<div class="muted">No active recipe.</div>`;
    const out = item(r.output_item_id);
    const lines = requiredInputs(r, scale);
    const outputUnit = r.output_unit || outputUnitForItem(out);
    const errors = unitErrors(lines, out, outputUnit);
    const shortages = lines.filter(x => Number(x.required_qty || 0) > stockQty(x.item_id));
    const grossOutput = actualOutput + waste;
    const variance = actualOutput - expectedOutput;
    const variancePct = expectedOutput ? (Math.abs(variance) / expectedOutput) * 100 : 0;

    $("mainInputWrap").style.display = scaleInput ? "" : "none";
    $("batchPreview").innerHTML = `
      <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Output Item</div><div><b>${esc(itemLabel(out))}</b></div></div>
        <div class="card"><div class="stat-title">Scale Factor</div><div><b>${qty(scale)}</b></div></div>
        <div class="card"><div class="stat-title">Expected Output</div><div><b>${qty(expectedOutput)} ${esc(outputUnit)}</b></div></div>
        <div class="card"><div class="stat-title">Variance</div><div><b>${qty(variance)} ${esc(outputUnit)}</b></div><div class="muted">${qty(variancePct)}%</div></div>
      </div>
      ${scaleInput ? `<div class="muted" style="margin-bottom:10px">Scaling from ${esc(itemLabel(item(scaleInput.item_id)))}: ${qty(mainUsed)} ${esc(scaleInput.unit)} used.</div>` : `<div class="muted" style="margin-bottom:10px">No scaling base. Inputs scale from actual output.</div>`}
      ${errors.length ? `<div class="errorbox">${errors.map(esc).join("<br>")}</div>` : ""}
      ${shortages.length ? `<div class="errorbox">${shortages.map(x => `Not enough stock for ${esc(itemLabel(x.item))}. Required ${qty(x.required_qty)} ${esc(x.unit)}, available ${qty(stockQty(x.item_id))} ${esc(x.item?.stock_unit || "")}.`).join("<br>")}</div>` : ""}
      <table>
        <thead><tr><th>Input</th><th>Required Deduction</th><th>Current Stock</th><th>After</th><th>Movement</th></tr></thead>
        <tbody>
          ${lines.map(x => `<tr>
            <td>${esc(itemLabel(x.item))}</td>
            <td>${qty(x.required_qty)} ${esc(x.unit)}</td>
            <td>${esc(stockText(x.item_id))}</td>
            <td>${qty(stockQty(x.item_id) - Number(x.required_qty || 0))} ${esc(x.item?.stock_unit || "")}</td>
            <td><span class="badge red">PRODUCTION_INPUT</span></td>
          </tr>`).join("")}
          <tr>
            <td><b>${esc(itemLabel(out))}</b></td>
            <td><b>${qty(grossOutput)} ${esc(outputUnit)}</b><div class="muted">Net usable: ${qty(actualOutput)}${waste > 0 ? `, waste: ${qty(waste)}` : ""}</div></td>
            <td>${esc(stockText(r.output_item_id))}</td>
            <td>${qty(stockQty(r.output_item_id) + actualOutput)} ${esc(outputUnit)}</td>
            <td><span class="badge green">PRODUCTION_OUTPUT</span></td>
          </tr>
          ${waste > 0 ? `<tr><td><b>${esc(itemLabel(out))} waste</b></td><td>${qty(waste)} ${esc(outputUnit)}</td><td></td><td></td><td><span class="badge red">WASTE</span></td></tr>` : ""}
        </tbody>
      </table>
    `;
  }

  function initialiseSelected() {
    const r = selectedRecipe();
    if (!r) return;
    const scaleInput = scalingInputFor(r);
    $("mainInputQty").value = scaleInput ? Number(r.batch_main_input_qty || inputQty(scaleInput) || 1) : "";
    $("actualOutputQty").value = Number(r.output_qty || 0);
    $("wasteQty").value = 0;
    renderPreview();
  }

  $("batchRecipeSelect").onchange = initialiseSelected;
  $("mainInputQty").oninput = () => {
    const r = selectedRecipe();
    if (!r) return;
    const scaleInput = scalingInputFor(r);
    if (scaleInput) {
      const scale = calcScale(r, Number($("mainInputQty").value || 0), 0);
      $("actualOutputQty").value = Number(r.output_qty || 0) * scale;
    }
    renderPreview();
  };
  $("actualOutputQty").oninput = renderPreview;
  $("wasteQty").oninput = renderPreview;
  initialiseSelected();

  $("batchForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = selectedRecipe();
    if (!r) return toast("Select a recipe.", "error");
    const out = item(r.output_item_id);
    const scaleInput = scalingInputFor(r);
    const actualOutput = Number(fd.get("actual_output_qty") || 0);
    const mainUsed = scaleInput ? Number(fd.get("main_input_qty") || 0) : 0;
    const scale = calcScale(r, mainUsed, actualOutput);
    const expectedOutput = Number(r.output_qty || 0) * scale;
    const waste = Number(fd.get("waste_qty") || 0);
    const lines = requiredInputs(r, scale);
    const outputUnit = r.output_unit || outputUnitForItem(out);
    const errors = unitErrors(lines, out, outputUnit);
    if (errors.length) return toast(errors[0], "error");
    if (actualOutput <= 0) return toast("Actual output must be greater than zero.", "error");
    if (waste < 0) return toast("Waste cannot be negative.", "error");

    const shortages = lines.filter(x => Number(x.required_qty || 0) > stockQty(x.item_id));
    const allowNegative = isManager() && fd.get("allow_negative") === "on";
    if (shortages.length && !allowNegative) {
      const x = shortages[0];
      return toast(`Not enough stock for ${itemLabel(x.item)}. Required ${qty(x.required_qty)} ${x.unit}, available ${qty(stockQty(x.item_id))} ${x.item?.stock_unit || ""}.`, "error");
    }

    const batchNumber = `PB-${Date.now().toString().slice(-8)}`;
    try {
      const batch = await insertRow("production_batches", {
        batch_number: batchNumber,
        branch_id: state.currentBranchId,
        recipe_id: r.id,
        output_item_id: r.output_item_id,
        actual_base_qty: scaleInput ? mainUsed : actualOutput,
        scaled_output_qty: expectedOutput,
        planned_output_qty: expectedOutput,
        actual_output_qty: actualOutput,
        output_unit: outputUnit,
        scale_factor: scale,
        status: "completed",
        batch_date: fd.get("production_date") || today(),
        production_date: fd.get("production_date") || today(),
        notes: fd.get("notes") || null,
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });

      for (const line of lines) {
        await addStockMovement({
          item_id: line.item_id,
          movement_type: "PRODUCTION_INPUT",
          qty_change: -Math.abs(Number(line.required_qty || 0)),
          stock_unit: line.unit,
          reference_id: batch.id,
          notes: `Production input for ${batchNumber}`,
        });
      }

      await addStockMovement({
        item_id: r.output_item_id,
        movement_type: "PRODUCTION_OUTPUT",
        qty_change: Math.abs(actualOutput + waste),
        stock_unit: outputUnit,
        reference_id: batch.id,
        notes: `Production output for ${batchNumber}`,
      });

      if (waste > 0) {
        await addStockMovement({
          item_id: r.output_item_id,
          movement_type: "WASTE",
          qty_change: -Math.abs(waste),
          stock_unit: outputUnit,
          reference_id: batch.id,
          notes: `Production waste/loss for ${batchNumber}`,
        });
      }

      await maybeCreateVarianceAlert(batch, r, expectedOutput, actualOutput, outputUnit);
      toast("Production completed.", "ok");
      closeModal();
      renderProduction();
    } catch (err) {
      toast("Production failed: " + err.message, "error");
    }
  };
}

async function addStockMovement({ item_id, movement_type, qty_change, stock_unit, reference_id, notes }) {
  const payload = {
    branch_id: state.currentBranchId,
    item_id,
    movement_type,
    qty_change,
    qty: qty_change,
    quantity: qty_change,
    stock_unit,
    unit: stock_unit,
    reference_id,
    reference_type: "production",
    notes,
    created_by: state.user.id,
  };
  const { error } = await state.db.from("stock_movements").insert(payload);
  if (error) throw error;
}

async function maybeCreateVarianceAlert(batch, recipe, expected, actual, unit) {
  const variance = Number(actual || 0) - Number(expected || 0);
  const pct = expected ? Math.abs(variance) / Number(expected) : 0;
  if (pct < 0.05) return;
  await state.db.from("alerts").insert({
    branch_id: state.currentBranchId,
    alert_type: "PRODUCTION_VARIANCE",
    title: "Production output variance",
    detail: {
      batch_id: batch.id,
      batch_number: batch.batch_number,
      recipe_id: recipe.id,
      recipe_name: recipeName(recipe),
      expected_output: expected,
      actual_output: actual,
      variance,
      unit,
    },
    reference_id: batch.id,
    reference_type: "production",
    status: "open",
  });
}

function movementsForBatch(batchId) {
  return batchMovements.filter(m => m.reference_id === batchId);
}

function openBatchDetails(batch) {
  if (!batch) return;
  const r = recipes.find(x => x.id === batch.recipe_id);
  const out = item(batch.output_item_id);
  const moves = movementsForBatch(batch.id);
  const expected = Number(batch.planned_output_qty ?? batch.scaled_output_qty ?? 0);
  const actual = Number(batch.actual_output_qty || 0);
  const variance = actual - expected;

  openModal(`
    <div class="modal-head"><h3>Production Batch ${esc(batchNo(batch))}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Recipe</div><div><b>${esc(recipeName(r))}</b></div></div>
        <div class="card"><div class="stat-title">Output</div><div><b>${esc(itemLabel(out))}</b></div></div>
        <div class="card"><div class="stat-title">Expected</div><div><b>${qty(expected)} ${esc(batch.output_unit || "")}</b></div></div>
        <div class="card"><div class="stat-title">Actual / Variance</div><div><b>${qty(actual)} / ${qty(variance)}</b></div></div>
      </div>
      <table>
        <thead><tr><th>Movement</th><th>Item</th><th>Qty Change</th><th>Unit</th><th>Notes</th></tr></thead>
        <tbody>
          ${moves.map(m => `<tr><td>${esc(m.movement_type)}</td><td>${esc(itemLabel(item(m.item_id)))}</td><td>${qty(m.qty_change)}</td><td>${esc(m.stock_unit || m.unit || "")}</td><td>${esc(m.notes || "")}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No movements found.</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
}

function openCancelBatchModal(batch) {
  if (!isManager()) return toast("Only managers can cancel production.", "error");
  if (!batch || batch.status === "cancelled") return;
  const moves = movementsForBatch(batch.id).filter(m => !String(m.notes || "").includes("Cancellation reversal"));
  openModal(`
    <div class="modal-head"><h3>Cancel ${esc(batchNo(batch))}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="cancelBatchForm">
      <div class="modal-body">
        <div class="errorbox">Cancelling will keep the batch history and create reverse stock movements. Nothing will be deleted.</div>
        <label>Reason</label>
        <textarea name="reason" class="input" required rows="3"></textarea>
        <table style="margin-top:14px">
          <thead><tr><th>Original Movement</th><th>Item</th><th>Reverse Qty</th><th>Unit</th></tr></thead>
          <tbody>${moves.map(m => `<tr><td>${esc(m.movement_type)}</td><td>${esc(itemLabel(item(m.item_id)))}</td><td>${qty(-Number(m.qty_change || 0))}</td><td>${esc(m.stock_unit || m.unit || "")}</td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Keep Batch</button>
        <button class="btn red">Cancel Production</button>
      </div>
    </form>
  `);

  $("cancelBatchForm").onsubmit = async e => {
    e.preventDefault();
    const reason = new FormData(e.target).get("reason");
    try {
      for (const m of moves) {
        await addStockMovement({
          item_id: m.item_id,
          movement_type: m.movement_type,
          qty_change: -Number(m.qty_change || 0),
          stock_unit: m.stock_unit || m.unit || "",
          reference_id: batch.id,
          notes: `Cancellation reversal for ${batchNo(batch)}. ${reason}`,
        });
      }
      await updateRow("production_batches", batch.id, { status: "cancelled", notes: `${batch.notes || ""}\nCancelled: ${reason}`.trim(), updated_at: new Date().toISOString() });
      toast("Production cancelled and reversed.", "ok");
      closeModal();
      renderProduction();
    } catch (err) {
      toast("Cancel failed: " + err.message, "error");
    }
  };
}
