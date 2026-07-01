import { state, isManager } from "../state.js";
import { $, esc, showError, toast, openModal, closeModal } from "../utils.js";
import { safeSelect } from "../services/db.js";

export const supplierName = supplier => supplier?.company_name || supplier?.name || supplier?.supplier_name || "Supplier";

async function loadSuppliers() {
  state.suppliers = await safeSelect("suppliers", "*", { order: "created_at", ascending: false }).catch(() => safeSelect("suppliers", "*"));
}

export async function renderSuppliers() {
  if (!isManager()) return $("content").innerHTML = showError("Staff users cannot access Suppliers.");

  const content = $("content");
  content.innerHTML = '<div class="card">Loading suppliers...</div>';

  try {
    await loadSuppliers();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Suppliers</h2>
          <div class="toolbar">
            <input id="supplierSearch" class="input" placeholder="Search supplier...">
            <button class="btn" id="addSupplierBtn">+ Add Supplier</button>
          </div>
        </div>
        <div id="suppliersTable"></div>
      </div>
    `;
    $("supplierSearch").oninput = renderSupplierTable;
    $("addSupplierBtn").onclick = () => openSupplierModal();
    renderSupplierTable();
  } catch (e) {
    content.innerHTML = showError(e.message);
  }
}

function renderSupplierTable() {
  const q = ($("supplierSearch")?.value || "").toLowerCase();
  const rows = state.suppliers.filter(supplier => JSON.stringify(supplier).toLowerCase().includes(q));

  $("suppliersTable").innerHTML = `
    <table>
      <thead><tr><th>Company</th><th>Contact</th><th>Phone</th><th>Email</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(supplier => `<tr>
          <td><b>${esc(supplierName(supplier))}</b><div class="muted">${esc(supplier.address || supplier.company_address || "")}</div></td>
          <td>${esc(supplier.contact_person || "")}</td>
          <td>${esc(supplier.phone || supplier.company_phone || supplier.contact_mobile || "")}</td>
          <td>${esc(supplier.email || supplier.company_email || "")}</td>
          <td>${supplier.active === false ? '<span class="badge red">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
          <td>
            <button class="btn secondary small edit-supplier" data-id="${esc(supplier.id)}">Edit</button>
            <button class="btn red small delete-supplier" data-id="${esc(supplier.id)}">Delete</button>
          </td>
        </tr>`).join("") || '<tr><td colspan="6" class="muted">No suppliers yet.</td></tr>'}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".edit-supplier").forEach(button => {
    button.onclick = () => openSupplierModal(state.suppliers.find(supplier => supplier.id === button.dataset.id));
  });
  document.querySelectorAll(".delete-supplier").forEach(button => {
    button.onclick = () => openDeleteSupplierModal(state.suppliers.find(supplier => supplier.id === button.dataset.id));
  });
}

function openSupplierModal(supplier = null) {
  const edit = !!supplier;
  openModal(`
    <div class="modal-head">
      <h3>${edit ? "Edit Supplier" : "Add Supplier"}</h3>
      <button class="btn secondary small" onclick="closeModal()">x</button>
    </div>
    <form id="supplierForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Company Name</label><input name="company_name" class="input" required value="${esc(supplierName(supplier || {}))}"></div>
          <div><label>Contact Person</label><input name="contact_person" class="input" value="${esc(supplier?.contact_person || "")}"></div>
          <div><label>Company Phone</label><input name="company_phone" class="input" value="${esc(supplier?.company_phone || supplier?.phone || "")}"></div>
          <div><label>Contact Mobile</label><input name="contact_mobile" class="input" value="${esc(supplier?.contact_mobile || "")}"></div>
          <div><label>Company Email</label><input name="company_email" class="input" value="${esc(supplier?.company_email || supplier?.email || "")}"></div>
          <div><label>Status</label><select name="active"><option value="true">Active</option><option value="false">Inactive</option></select></div>
          <div class="full"><label>Address</label><textarea name="company_address" class="input">${esc(supplier?.company_address || supplier?.address || "")}</textarea></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input">${esc(supplier?.notes || "")}</textarea></div>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        <button class="btn">Save</button>
      </div>
    </form>
  `);

  if (supplier?.active === false) document.querySelector("[name='active']").value = "false";

  $("supplierForm").onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = {
      company_name: form.get("company_name"),
      contact_person: form.get("contact_person") || null,
      company_phone: form.get("company_phone") || null,
      contact_mobile: form.get("contact_mobile") || null,
      company_email: form.get("company_email") || null,
      company_address: form.get("company_address") || null,
      notes: form.get("notes") || null,
      active: form.get("active") === "true",
      updated_at: new Date().toISOString(),
    };

    const result = edit
      ? await state.db.from("suppliers").update(payload).eq("id", supplier.id)
      : await state.db.from("suppliers").insert(payload);

    if (result.error) return toast(result.error.message, "error");
    toast("Supplier saved.", "ok");
    closeModal();
    renderSuppliers();
  };
}

async function supplierItemCount(supplierId) {
  const { count, error } = await state.db
    .from("items")
    .select("*", { count: "exact", head: true })
    .eq("primary_supplier_id", supplierId);
  if (error) throw error;
  return count || 0;
}

function openDeleteSupplierModal(supplier) {
  if (!supplier) return;

  openModal(`
    <div class="modal-head">
      <h3>Delete Supplier</h3>
      <button class="btn secondary small" onclick="closeModal()">x</button>
    </div>
    <div class="modal-body">
      <div class="errorbox">
        Delete <b>${esc(supplierName(supplier))}</b>? This cannot be undone.
      </div>
      <div class="muted">If this supplier is used by items, deletion will be blocked. In that case, mark it inactive instead.</div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn red" id="confirmDeleteSupplier">Delete</button>
    </div>
  `);

  $("confirmDeleteSupplier").onclick = async () => {
    try {
      const linkedItems = await supplierItemCount(supplier.id);
      if (linkedItems > 0) {
        return toast(`Cannot delete supplier. ${linkedItems} item(s) still use this supplier. Mark it inactive instead.`, "error");
      }

      const result = await state.db.from("suppliers").delete().eq("id", supplier.id);
      if (result.error) return toast(result.error.message, "error");

      toast("Supplier deleted.", "ok");
      closeModal();
      renderSuppliers();
    } catch (err) {
      toast("Delete failed: " + err.message, "error");
    }
  };
}
