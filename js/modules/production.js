import { state, isManager } from "../state.js";
import { $, esc, money, qty, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect, insertRow, updateRow, deleteRows } from "../services/db.js";
import { loadItems, loadItemDeps } from "./items.js";

let recipes = [];
let recipeInputs = [];
let batches = [];
let stockBalances = [];
let filters = { search:"", recipe_id:"" };

const same = (a,b) => String(a||"").toLowerCase().trim() === String(b||"").toLowerCase().trim();
const item = id => (state.items || []).find(i => i.id === id);
const itemLabel = i => i ? `${i.name}${i.name_ar ? " / " + i.name_ar : ""}` : "Item";
const recipeNo = r => r?.name || `Recipe-${String(r?.id || "").slice(0,8)}`;
const batchNo = b => b?.batch_number || `PB-${String(b?.id || "").slice(0,8)}`;

function branchName(){
  const b = (state.branches || []).find(x => x.id === state.currentBranchId) || {};
  return b.name || b.branch_name || b.title || state.currentBranchId || "";
}

function outputUnitForItem(it){
  return it?.stock_unit || it?.receiving_unit || it?.purchase_package_unit || "";
}

function stockText(itemId){
  const it = item(itemId);
  const b = stockBalances.find(x => x.item_id === itemId);
  const amount = b ? Number(b.qty_on_hand ?? b.current_qty ?? b.quantity ?? 0) : 0;
  return `${qty(amount)} ${it?.stock_unit || ""}`;
}

async function loadProductionData(){
  await loadItemDeps();
  await loadItems();

  recipes = await safeSelect("production_recipes","*", { order:"created_at", ascending:false }).catch(()=>[]);
  recipeInputs = await safeSelect("production_recipe_inputs","*", { order:"sort_order" }).catch(()=>[]);
  batches = await safeSelect("production_batches","*", { eq:{ branch_id: state.currentBranchId }, order:"created_at", ascending:false }).catch(()=>[]);
  stockBalances = await safeSelect("stock_balances","*", { eq:{ branch_id: state.currentBranchId } }).catch(()=>[]);
}

export async function renderProduction(){
  if(!isManager()) return $("content").innerHTML = showError("Staff users cannot access Production setup/actions yet.");

  const c = $("content");
  c.innerHTML = `<div class="card">Loading production...</div>`;

  try{
    await loadProductionData();

    c.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Production</h2>
          <div class="toolbar">
            <input id="prodSearch" class="input" placeholder="Search recipes or batches...">
            <button class="btn secondary" id="newRecipeBtn">+ Recipe Setup</button>
            <button class="btn" id="newBatchBtn">+ Production Action</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">
          Branch: <b>${esc(branchName())}</b>. Production deducts raw inputs and adds prepared/output stock.
        </div>
        <div id="productionDashboard"></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Production Recipes</h2></div>
        <div id="recipesTable"></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Recent Production Batches</h2></div>
        <div id="batchesTable"></div>
      </div>
    `;

    $("prodSearch").value = filters.search;
    $("prodSearch").oninput = e => { filters.search = e.target.value; renderProductionTables(); };
    $("newRecipeBtn").onclick = () => openRecipeModal();
    $("newBatchBtn").onclick = () => openBatchModal();

    renderProductionTables();
  }catch(e){
    c.innerHTML = showError("Could not load Production. " + e.message);
  }
}

function renderProductionTables(){
  const q = filters.search.toLowerCase();

  const recipeRows = recipes.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  const batchRows = batches.filter(b => JSON.stringify(b).toLowerCase().includes(q));

  $("productionDashboard").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Active Recipes</div><div><b>${recipes.filter(r=>r.is_active !== false).length}</b></div></div>
      <div class="card"><div class="stat-title">Batches This Branch</div><div><b>${batches.length}</b></div></div>
      <div class="card"><div class="stat-title">Today Batches</div><div><b>${batches.filter(b => (b.production_date || b.created_at || "").slice(0,10) === new Date().toISOString().slice(0,10)).length}</b></div></div>
    </div>
  `;

  $("recipesTable").innerHTML = `
    <table>
      <thead>
        <tr><th>Recipe</th><th>Output Item</th><th>Standard Output</th><th>Main Scaling Input</th><th>Inputs</th><th></th></tr>
      </thead>
      <tbody>
        ${recipeRows.map(r => {
          const out = item(r.output_item_id);
          const main = item(r.batch_main_input_item_id);
          const inputs = recipeInputs.filter(x => x.recipe_id === r.id);
          return `<tr>
            <td><b>${esc(recipeNo(r))}</b><div class="muted">${esc(r.notes || "")}</div></td>
            <td>${esc(itemLabel(out))}</td>
            <td>${qty(r.output_qty || 0)} ${esc(r.output_unit || outputUnitForItem(out))}</td>
            <td>${main ? `${esc(itemLabel(main))} (${qty(r.batch_main_input_qty || 1)})` : "-"}</td>
            <td>${inputs.length}</td>
            <td>
              <button class="btn secondary small edit-recipe" data-id="${esc(r.id)}">Open</button>
              <button class="btn small make-batch" data-id="${esc(r.id)}">Produce</button>
            </td>
          </tr>`;
        }).join("") || '<tr><td colspan="6" class="muted">No recipes yet.</td></tr>'}
      </tbody>
    </table>
  `;

  $("batchesTable").innerHTML = `
    <table>
      <thead>
        <tr><th>Batch</th><th>Date</th><th>Recipe</th><th>Output</th><th>Status</th><th>Notes</th></tr>
      </thead>
      <tbody>
        ${batchRows.map(b => {
          const r = recipes.find(x => x.id === b.recipe_id);
          const out = item(b.output_item_id);
          return `<tr>
            <td><b>${esc(batchNo(b))}</b></td>
            <td>${esc((b.production_date || b.created_at || "").slice(0,10))}</td>
            <td>${esc(recipeNo(r))}</td>
            <td>${qty(b.actual_output_qty || b.planned_output_qty || 0)} ${esc(b.output_unit || outputUnitForItem(out))} ${esc(itemLabel(out))}</td>
            <td><span class="badge green">${esc(b.status || "completed")}</span></td>
            <td>${esc(b.notes || "")}</td>
          </tr>`;
        }).join("") || '<tr><td colspan="6" class="muted">No production batches yet.</td></tr>'}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".edit-recipe").forEach(btn => btn.onclick = () => openRecipeModal(recipes.find(r => r.id === btn.dataset.id)));
  document.querySelectorAll(".make-batch").forEach(btn => btn.onclick = () => openBatchModal(recipes.find(r => r.id === btn.dataset.id)));
}

function blankInputLine(){
  return { item_id:"", qty:0, unit:"", is_scaling_base:false, notes:"" };
}

function inputFromItem(it){
  return { item_id: it.id, qty:1, unit: it.stock_unit || it.receiving_unit || "", is_scaling_base:false, notes:"" };
}

function openRecipeModal(recipe=null){
  const isEdit = !!recipe;
  const localInputs = isEdit
    ? recipeInputs.filter(x => x.recipe_id === recipe.id).map(x => ({...x}))
    : [blankInputLine()];

  openModal(`
    <div class="modal-head">
      <h3>${isEdit ? "Production Recipe" : "New Production Recipe"}</h3>
      <button class="btn secondary small" onclick="closeModal()">✕</button>
    </div>

    <form id="recipeForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Recipe Name</label><input name="name" class="input" required value="${esc(recipe?.name || "")}" placeholder="Mandi Rice"></div>
          <div><label>Arabic Name</label><input name="name_ar" class="input" value="${esc(recipe?.name_ar || "")}"></div>
          <div><label>Output Stock Item</label><select name="output_item_id" required>${state.items.map(i=>`<option value="${esc(i.id)}" ${i.id===recipe?.output_item_id?"selected":""}>${esc(itemLabel(i))}</option>`).join("")}</select></div>
          <div><label>Standard Output Qty</label><input name="output_qty" type="number" step="0.001" class="input" required value="${esc(recipe?.output_qty ?? 1)}"></div>
          <div><label>Output Unit</label><input name="output_unit" class="input" value="${esc(recipe?.output_unit || "")}" placeholder="plates / kg / pcs"></div>
          <div><label>Batch Main Input Qty</label><input name="batch_main_input_qty" type="number" step="0.001" class="input" value="${esc(recipe?.batch_main_input_qty ?? 1)}"></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2">${esc(recipe?.notes || "")}</textarea></div>
        </div>

        <div class="section-head" style="margin-top:16px">
          <h3 style="margin:0">Recipe Inputs</h3>
          <button type="button" class="btn secondary small" id="addRecipeInputBtn">+ Add Input</button>
        </div>

        <div class="muted" style="margin:8px 0">
          Mark one line as Scaling Base if you want production quantity to scale from that input. Example: rice 5 kg gives 40 plates; if staff enters 10 kg, inputs and output double.
        </div>

        <div id="recipeInputsBox"></div>
      </div>

      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn">Save Recipe</button>
      </div>
    </form>
  `);

  function renderInputLines(){
    $("recipeInputsBox").innerHTML = `
      <table>
        <thead><tr><th>Input Item</th><th>Qty</th><th>Unit</th><th>Scaling Base</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${localInputs.map((line, idx) => {
            const it = item(line.item_id);
            return `<tr>
              <td><select class="recipe-input-item" data-idx="${idx}"><option value="">-- Select --</option>${state.items.map(i=>`<option value="${esc(i.id)}" ${i.id===line.item_id?"selected":""}>${esc(itemLabel(i))}</option>`).join("")}</select></td>
              <td><input type="number" step="0.001" class="input recipe-input-qty" data-idx="${idx}" value="${esc(line.qty ?? 0)}"></td>
              <td><input class="input recipe-input-unit" data-idx="${idx}" value="${esc(line.unit || it?.stock_unit || "")}"></td>
              <td><input type="radio" name="scaling_base" class="recipe-scale-base" data-idx="${idx}" ${line.is_scaling_base ? "checked" : ""}></td>
              <td><input class="input recipe-input-note" data-idx="${idx}" value="${esc(line.notes || "")}"></td>
              <td><button type="button" class="btn red small remove-recipe-line" data-idx="${idx}">×</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
    bindInputLineEvents();
  }

  function bindInputLineEvents(){
    document.querySelectorAll(".recipe-input-item").forEach(el => el.onchange = e => {
      const idx = Number(e.target.dataset.idx);
      const it = item(e.target.value);
      localInputs[idx] = it ? {...localInputs[idx], ...inputFromItem(it)} : blankInputLine();
      renderInputLines();
    });
    document.querySelectorAll(".recipe-input-qty").forEach(el => el.oninput = e => localInputs[Number(e.target.dataset.idx)].qty = Number(e.target.value || 0));
    document.querySelectorAll(".recipe-input-unit").forEach(el => el.oninput = e => localInputs[Number(e.target.dataset.idx)].unit = e.target.value);
    document.querySelectorAll(".recipe-input-note").forEach(el => el.oninput = e => localInputs[Number(e.target.dataset.idx)].notes = e.target.value);
    document.querySelectorAll(".recipe-scale-base").forEach(el => el.onchange = e => {
      localInputs.forEach(x => x.is_scaling_base = false);
      localInputs[Number(e.target.dataset.idx)].is_scaling_base = true;
    });
    document.querySelectorAll(".remove-recipe-line").forEach(el => el.onclick = e => {
      localInputs.splice(Number(e.target.dataset.idx), 1);
      if(!localInputs.length) localInputs.push(blankInputLine());
      renderInputLines();
    });
  }

  renderInputLines();
  $("addRecipeInputBtn").onclick = () => { localInputs.push(blankInputLine()); renderInputLines(); };

  $("recipeForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const outputIt = item(fd.get("output_item_id"));
    const scaleBase = localInputs.find(x => x.is_scaling_base);
    const payload = {
      name: fd.get("name"),
      name_ar: fd.get("name_ar") || null,
      output_item_id: fd.get("output_item_id"),
      output_qty: Number(fd.get("output_qty") || 0),
      output_unit: fd.get("output_unit") || outputUnitForItem(outputIt),
      batch_main_input_item_id: scaleBase?.item_id || null,
      batch_main_input_qty: scaleBase ? Number(scaleBase.qty || 1) : Number(fd.get("batch_main_input_qty") || 1),
      is_active: true,
      notes: fd.get("notes") || null,
      updated_at: new Date().toISOString()
    };

    try{
      let saved;
      if(isEdit) saved = await updateRow("production_recipes", recipe.id, payload);
      else saved = await insertRow("production_recipes", payload);

      await deleteRows("production_recipe_inputs", "recipe_id", saved.id);

      const clean = localInputs.filter(x => x.item_id && Number(x.qty || 0) > 0).map((x, idx) => ({
        recipe_id: saved.id,
        item_id: x.item_id,
        qty: Number(x.qty || 0),
        unit: x.unit || item(x.item_id)?.stock_unit || "",
        is_scaling_base: !!x.is_scaling_base,
        notes: x.notes || null,
        sort_order: idx
      }));

      if(clean.length){
        const { error } = await state.db.from("production_recipe_inputs").insert(clean);
        if(error) throw error;
      }

      toast("Production recipe saved.", "ok");
      closeModal();
      renderProduction();
    }catch(err){
      toast("Recipe save failed: " + err.message, "error");
    }
  };
}

function inputsForRecipe(recipeId){
  return recipeInputs.filter(x => x.recipe_id === recipeId);
}

function openBatchModal(recipe=null){
  const activeRecipes = recipes.filter(r => r.is_active !== false);
  const selected = recipe || activeRecipes[0];

  openModal(`
    <div class="modal-head">
      <h3>Production Action</h3>
      <button class="btn secondary small" onclick="closeModal()">✕</button>
    </div>

    <form id="batchForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Branch</label><input class="input" value="${esc(branchName())}" disabled></div>
          <div><label>Production Date</label><input name="production_date" type="date" class="input" value="${new Date().toISOString().slice(0,10)}"></div>
          <div><label>Recipe</label><select name="recipe_id" id="batchRecipeSelect">${activeRecipes.map(r=>`<option value="${esc(r.id)}" ${r.id===selected?.id?"selected":""}>${esc(recipeNo(r))}</option>`).join("")}</select></div>
          <div><label>Main Input Used</label><input name="main_input_qty" id="mainInputQty" type="number" step="0.001" class="input"></div>
          <div><label>Actual Output Qty</label><input name="actual_output_qty" id="actualOutputQty" type="number" step="0.001" class="input"></div>
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

  function selectedRecipe(){
    return recipes.find(r => r.id === $("batchRecipeSelect").value);
  }

  function calcScale(){
    const r = selectedRecipe();
    if(!r) return 1;
    const entered = Number($("mainInputQty").value || r.batch_main_input_qty || 1);
    const base = Number(r.batch_main_input_qty || 1);
    return base ? entered / base : 1;
  }

  function renderPreview(){
    const r = selectedRecipe();
    if(!r){
      $("batchPreview").innerHTML = `<div class="muted">No active recipe.</div>`;
      return;
    }

    const out = item(r.output_item_id);
    const inputs = inputsForRecipe(r.id);
    const scale = calcScale();
    const plannedOutput = Number(r.output_qty || 0) * scale;

    if(!$("actualOutputQty").value) $("actualOutputQty").value = plannedOutput || 0;

    $("batchPreview").innerHTML = `
      <div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
        <div class="card"><div class="stat-title">Output Item</div><div><b>${esc(itemLabel(out))}</b></div></div>
        <div class="card"><div class="stat-title">Planned Output</div><div><b>${qty(plannedOutput)} ${esc(r.output_unit || outputUnitForItem(out))}</b></div></div>
        <div class="card"><div class="stat-title">Scale Factor</div><div><b>${qty(scale)}</b></div></div>
      </div>
      <table>
        <thead><tr><th>Input</th><th>Required</th><th>Current Stock</th><th>Movement</th></tr></thead>
        <tbody>
          ${inputs.map(x => {
            const it = item(x.item_id);
            const required = Number(x.qty || 0) * scale;
            return `<tr>
              <td>${esc(itemLabel(it))}</td>
              <td>${qty(required)} ${esc(x.unit || it?.stock_unit || "")}</td>
              <td>${esc(stockText(x.item_id))}</td>
              <td><span class="badge red">PRODUCTION_INPUT</span></td>
            </tr>`;
          }).join("") || '<tr><td colspan="4" class="muted">No inputs in this recipe.</td></tr>'}
          <tr>
            <td><b>${esc(itemLabel(out))}</b></td>
            <td><b>${qty(Number($("actualOutputQty").value || plannedOutput))} ${esc(r.output_unit || outputUnitForItem(out))}</b></td>
            <td>${esc(stockText(r.output_item_id))}</td>
            <td><span class="badge green">PRODUCTION_OUTPUT</span></td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function initialiseSelected(){
    const r = selectedRecipe();
    if(!r) return;
    $("mainInputQty").value = r.batch_main_input_qty || 1;
    $("actualOutputQty").value = r.output_qty || 0;
    renderPreview();
  }

  $("batchRecipeSelect").onchange = initialiseSelected;
  $("mainInputQty").oninput = () => {
    const r = selectedRecipe();
    const scale = calcScale();
    $("actualOutputQty").value = Number(r?.output_qty || 0) * scale;
    renderPreview();
  };
  $("actualOutputQty").oninput = renderPreview;

  initialiseSelected();

  $("batchForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = selectedRecipe();
    if(!r) return toast("Select a recipe.", "error");

    const inputs = inputsForRecipe(r.id);
    const scale = calcScale();
    const out = item(r.output_item_id);
    const actualOutput = Number(fd.get("actual_output_qty") || 0);
    const batchNumber = `PB-${Date.now().toString().slice(-8)}`;

    try{
      const batch = await insertRow("production_batches", {
        batch_number: batchNumber,
        branch_id: state.currentBranchId,
        recipe_id: r.id,
        output_item_id: r.output_item_id,
        planned_output_qty: Number(r.output_qty || 0) * scale,
        actual_output_qty: actualOutput,
        output_unit: r.output_unit || outputUnitForItem(out),
        scale_factor: scale,
        status: "completed",
        production_date: fd.get("production_date"),
        notes: fd.get("notes") || null,
        created_by: state.user.id
      });

      for(const x of inputs){
        const it = item(x.item_id);
        const amount = Number(x.qty || 0) * scale;
        await addStockMovement({
          item_id: x.item_id,
          movement_type: "PRODUCTION_INPUT",
          qty_change: -Math.abs(amount),
          stock_unit: x.unit || it?.stock_unit || "",
          reference_id: batch.id,
          notes: `Production input for ${batchNumber}`
        });
      }

      await addStockMovement({
        item_id: r.output_item_id,
        movement_type: "PRODUCTION_OUTPUT",
        qty_change: Math.abs(actualOutput),
        stock_unit: r.output_unit || outputUnitForItem(out),
        reference_id: batch.id,
        notes: `Production output for ${batchNumber}`
      });

      toast("Production completed.", "ok");
      closeModal();
      renderProduction();
    }catch(err){
      toast("Production failed: " + err.message, "error");
    }
  };
}

async function addStockMovement({item_id, movement_type, qty_change, stock_unit, reference_id, notes}){
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
    created_by: state.user.id
  };
  const { error } = await state.db.from("stock_movements").insert(payload);
  if(error) throw error;
}
