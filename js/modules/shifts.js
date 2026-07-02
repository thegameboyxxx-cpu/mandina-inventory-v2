import { state, isManager } from "../state.js";
import { $, esc, money, showError, toast, openModal, closeModal, today } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";

let employees = [];
let shifts = [];
let view = { start: today(), mode: "week" };

const employee = id => employees.find(e => e.id === id);
const employeeLabel = e => e ? `${e.full_name} (#${e.employee_number})` : "Employee";
const branchName = id => (state.branches || []).find(b => b.id === id)?.name || id || "-";

async function loadShiftData() {
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  shifts = await safeSelect("shift_schedules", "*", { eq: { branch_id: state.currentBranchId }, order: "shift_date" }).catch(() => []);
}

export async function renderShifts() {
  const content = $("content");
  if (!isManager()) {
    content.innerHTML = showError("Manager access required.");
    return;
  }
  content.innerHTML = '<div class="card">Loading shifts...</div>';
  try {
    await loadShiftData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Shift Planner</h2>
          <div class="toolbar">
            <input id="shiftStart" class="input" type="date" value="${esc(view.start)}">
            <select id="shiftMode"><option value="week" ${view.mode === "week" ? "selected" : ""}>Week</option><option value="day" ${view.mode === "day" ? "selected" : ""}>Day</option></select>
            <button class="btn secondary" id="prevShiftView">Prev</button>
            <button class="btn secondary" id="nextShiftView">Next</button>
            <button class="btn" id="addShiftBtn">+ Shift</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Planned cost uses scheduled hours times employee hourly rate. Time and GPS enforcement are not active for testing yet.</div>
        <div id="shiftPlanner"></div>
      </div>
    `;
    $("shiftStart").onchange = e => { view.start = e.target.value; renderShiftPlanner(); };
    $("shiftMode").onchange = e => { view.mode = e.target.value; renderShiftPlanner(); };
    $("prevShiftView").onclick = () => moveView(view.mode === "week" ? -7 : -1);
    $("nextShiftView").onclick = () => moveView(view.mode === "week" ? 7 : 1);
    $("addShiftBtn").onclick = () => openShiftModal();
    renderShiftPlanner();
  } catch (err) {
    content.innerHTML = showError("Could not load Shift Planner. " + err.message);
  }
}

function moveView(days) {
  view.start = dateShift(view.start, days);
  $("shiftStart").value = view.start;
  renderShiftPlanner();
}

function renderShiftPlanner() {
  view.start = $("shiftStart")?.value || view.start || today();
  view.mode = $("shiftMode")?.value || view.mode || "week";
  const days = view.mode === "week" ? weekDays(view.start) : [view.start];
  const rows = shifts.filter(s => s.status !== "cancelled" && days.includes(s.shift_date));
  const plannedHours = rows.reduce((sum, s) => sum + shiftHours(s), 0);
  const plannedCost = rows.reduce((sum, s) => sum + shiftCost(s), 0);
  const warnings = buildWarnings(days, rows);
  $("shiftPlanner").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Branch</div><div><b>${esc(branchName(state.currentBranchId))}</b></div></div>
      <div class="card"><div class="stat-title">Shifts</div><div><b>${rows.length}</b></div></div>
      <div class="card"><div class="stat-title">Planned Hours</div><div><b>${plannedHours.toFixed(2)}</b></div></div>
      <div class="card"><div class="stat-title">Planned Cost</div><div><b>${money(plannedCost)}</b></div></div>
    </div>
    ${warnings.length ? `<div class="errorbox">${warnings.map(esc).join("<br>")}</div>` : ""}
    <div class="shift-board">
      ${days.map(day => renderDayColumn(day, rows.filter(s => s.shift_date === day))).join("")}
    </div>
  `;
  document.querySelectorAll(".edit-shift").forEach(btn => btn.onclick = () => openShiftModal(shifts.find(s => s.id === btn.dataset.id)));
}

function renderDayColumn(day, dayShifts) {
  const sorted = [...dayShifts].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const cost = sorted.reduce((sum, s) => sum + shiftCost(s), 0);
  return `
    <section class="shift-day">
      <div class="shift-day-head">
        <div><b>${esc(dayLabel(day))}</b><div class="muted">${esc(day)}</div></div>
        <span class="badge blue">${money(cost)}</span>
      </div>
      <div class="shift-lane">
        ${sorted.map(s => {
          const e = employee(s.employee_id);
          return `<button class="shift-block edit-shift" data-id="${esc(s.id)}" style="--shift-top:${shiftTop(s)}px;--shift-height:${shiftHeight(s)}px">
            <b>${esc(employeeLabel(e))}</b>
            <span>${esc(timeShort(s.start_time))} - ${esc(timeShort(s.end_time))}</span>
            <small>${shiftHours(s).toFixed(2)}h / ${money(shiftCost(s))}</small>
          </button>`;
        }).join("") || '<div class="muted" style="padding:12px">No shifts.</div>'}
      </div>
    </section>
  `;
}

function buildWarnings(days, rows) {
  const warnings = [];
  for (const day of days) {
    const dayRows = rows.filter(s => s.shift_date === day);
    if (!dayRows.length) warnings.push(`${day}: no shifts planned.`);
    for (let i = 0; i < dayRows.length; i += 1) {
      for (let j = i + 1; j < dayRows.length; j += 1) {
        if (overlaps(dayRows[i], dayRows[j])) warnings.push(`${day}: overlapping shifts between ${employeeLabel(employee(dayRows[i].employee_id))} and ${employeeLabel(employee(dayRows[j].employee_id))}.`);
      }
    }
  }
  return warnings.slice(0, 8);
}

function openShiftModal(shift = null) {
  const activeEmployees = employees.filter(e => e.active !== false && e.branch_id === state.currentBranchId);
  openModal(`
    <div class="modal-head"><h3>${shift ? "Edit Shift" : "Add Shift"}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="shiftForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Employee</label><select name="employee_id" required>${activeEmployees.map(e => `<option value="${esc(e.id)}" ${e.id === shift?.employee_id ? "selected" : ""}>${esc(employeeLabel(e))}</option>`).join("")}</select></div>
          <div><label>Shift Date</label><input name="shift_date" type="date" class="input" value="${esc(shift?.shift_date || view.start || today())}" required></div>
          <div><label>Start</label><input name="start_time" type="time" class="input" value="${esc((shift?.start_time || "10:00").slice(0, 5))}" required></div>
          <div><label>End</label><input name="end_time" type="time" class="input" value="${esc((shift?.end_time || "18:00").slice(0, 5))}" required></div>
          <div><label>Role</label><input name="role" class="input" value="${esc(shift?.role || "")}"></div>
          <div><label>Status</label><select name="status"><option value="planned" ${shift?.status !== "cancelled" ? "selected" : ""}>Planned</option><option value="cancelled" ${shift?.status === "cancelled" ? "selected" : ""}>Cancelled</option></select></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2">${esc(shift?.notes || "")}</textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div>
    </form>
  `);
  $("shiftForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get("end_time") <= fd.get("start_time")) return toast("End time must be after start time.", "error");
    const payload = {
      employee_id: fd.get("employee_id"),
      branch_id: state.currentBranchId,
      shift_date: fd.get("shift_date"),
      start_time: fd.get("start_time"),
      end_time: fd.get("end_time"),
      role: fd.get("role") || null,
      status: fd.get("status") || "planned",
      notes: fd.get("notes") || null,
      updated_at: new Date().toISOString(),
    };
    try {
      if (shift) await updateRow("shift_schedules", shift.id, payload);
      else await insertRow("shift_schedules", { ...payload, created_by: state.user.id });
      toast("Shift saved.", "ok");
      closeModal();
      renderShifts();
    } catch (err) {
      toast("Shift save failed: " + err.message, "error");
    }
  };
}

function weekDays(date) {
  const d = new Date(`${date}T00:00:00`);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

function dateShift(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayLabel(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

function timeShort(value) {
  return String(value || "").slice(0, 5);
}

function minutes(value) {
  const [h, m] = timeShort(value).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function shiftHours(s) {
  return Math.max(0, minutes(s.end_time) - minutes(s.start_time)) / 60;
}

function shiftCost(s) {
  return shiftHours(s) * Number(employee(s.employee_id)?.hourly_rate || 0);
}

function shiftTop(s) {
  return Math.max(0, (minutes(s.start_time) - 6 * 60) * 0.55);
}

function shiftHeight(s) {
  return Math.max(38, shiftHours(s) * 60 * 0.55);
}

function overlaps(a, b) {
  return minutes(a.start_time) < minutes(b.end_time) && minutes(b.start_time) < minutes(a.end_time);
}
