import { state, isManager } from "../state.js";
import { $, esc, money, showError, toast, openModal, closeModal, today } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";

let employees = [];
let shifts = [];
let templates = [];
let templateLines = [];
let view = { start: today(), mode: "week" };

const ROLE_OPTIONS = [
  ["front_staff", "Front Staff"],
  ["kitchen", "Kitchen"],
  ["back_kitchen", "Back Kitchen"],
  ["cashier", "Cashier"],
  ["driver", "Driver"],
  ["cleaner", "Cleaner"],
  ["manager", "Manager"],
];

const employee = id => employees.find(e => e.id === id);
const employeeLabel = e => e ? `${e.full_name} (#${e.employee_number})` : "Employee";
const roleLabel = value => ROLE_OPTIONS.find(r => r[0] === value)?.[1] || value || "Role";
const branchName = id => (state.branches || []).find(b => b.id === id)?.name || id || "-";

async function loadShiftData() {
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  shifts = await safeSelect("shift_schedules", "*", { eq: { branch_id: state.currentBranchId }, order: "shift_date" }).catch(() => []);
  templates = await safeSelect("shift_templates", "*", { eq: { branch_id: state.currentBranchId }, order: "name" }).catch(() => []);
  templateLines = await safeSelect("shift_template_lines", "*").catch(() => []);
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
            <button class="btn secondary" id="saveShiftTemplateBtn">Save Template</button>
            <button class="btn gold" id="applyShiftTemplateBtn">Apply Template</button>
            <button class="btn" id="addShiftBtn">+ Shift</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Weekly timeline view: days run down the left, time runs across the row, and overlapping shifts are stacked so no one is hidden.</div>
        <div id="shiftPlanner"></div>
      </div>
    `;
    $("shiftStart").onchange = e => { view.start = e.target.value; renderShiftPlanner(); };
    $("shiftMode").onchange = e => { view.mode = e.target.value; renderShiftPlanner(); };
    $("prevShiftView").onclick = () => moveView(view.mode === "week" ? -7 : -1);
    $("nextShiftView").onclick = () => moveView(view.mode === "week" ? 7 : 1);
    $("saveShiftTemplateBtn").onclick = openSaveTemplateModal;
    $("applyShiftTemplateBtn").onclick = openApplyTemplateModal;
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
  const range = timeRange(rows);
  $("shiftPlanner").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Branch</div><div><b>${esc(branchName(state.currentBranchId))}</b></div></div>
      <div class="card"><div class="stat-title">Shifts</div><div><b>${rows.length}</b></div></div>
      <div class="card"><div class="stat-title">Planned Hours</div><div><b>${plannedHours.toFixed(2)}</b></div></div>
      <div class="card"><div class="stat-title">Planned Cost</div><div><b>${money(plannedCost)}</b></div></div>
    </div>
    ${warnings.length ? `<div class="errorbox">${warnings.map(esc).join("<br>")}</div>` : ""}
    <div class="shift-timeline-wrap">
      ${renderTimeHeader(range)}
      ${days.map(day => renderTimelineDay(day, rows.filter(s => s.shift_date === day), range)).join("")}
    </div>
  `;
  document.querySelectorAll(".edit-shift").forEach(btn => btn.onclick = () => openShiftModal(shifts.find(s => s.id === btn.dataset.id)));
}

function renderTimeHeader(range) {
  const ticks = [];
  for (let m = range.start; m <= range.end; m += 60) ticks.push(m);
  return `
    <div class="shift-time-head" style="--time-width:${range.width}px">
      <div class="shift-day-label"></div>
      <div class="shift-time-scale">
        ${ticks.map(m => `<span style="left:${minuteLeft(m, range)}px">${esc(minutesToTime(m))}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderTimelineDay(day, dayShifts, range) {
  const layout = layoutShifts(dayShifts);
  const rowHeight = Math.max(56, layout.lanes * 46 + 12);
  const dayCost = dayShifts.reduce((sum, s) => sum + shiftCost(s), 0);
  return `
    <section class="shift-time-row" style="--time-width:${range.width}px;--row-height:${rowHeight}px">
      <div class="shift-day-label">
        <b>${esc(dayLabel(day))}</b>
        <span>${esc(day)}</span>
        <small>${dayShifts.length} shifts / ${money(dayCost)}</small>
      </div>
      <div class="shift-time-lane">
        ${layout.items.map(item => {
          const s = item.shift;
          const e = employee(s.employee_id);
          const left = minuteLeft(minutes(s.start_time), range);
          const width = Math.max(60, minuteLeft(minutes(s.end_time), range) - left);
          return `<button class="shift-pill edit-shift" data-id="${esc(s.id)}" style="left:${left}px;top:${8 + item.lane * 46}px;width:${width}px">
            <b>${esc(employeeLabel(e))}</b>
            <span>${esc(timeShort(s.start_time))}-${esc(timeShort(s.end_time))} · ${esc(roleLabel(s.role || e?.operational_role))}</span>
          </button>`;
        }).join("") || '<div class="muted" style="padding:12px">No shifts planned.</div>'}
      </div>
    </section>
  `;
}

function layoutShifts(dayShifts) {
  const sorted = [...dayShifts].sort((a, b) => minutes(a.start_time) - minutes(b.start_time));
  const laneEnds = [];
  const items = sorted.map(shift => {
    let lane = laneEnds.findIndex(end => end <= minutes(shift.start_time));
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = minutes(shift.end_time);
    return { shift, lane };
  });
  return { items, lanes: Math.max(1, laneEnds.length) };
}

function buildWarnings(days, rows) {
  const warnings = [];
  for (const day of days) {
    const dayRows = rows.filter(s => s.shift_date === day);
    if (!dayRows.length) warnings.push(`${day}: no shifts planned.`);
  }
  return warnings.slice(0, 8);
}

function openShiftModal(shift = null) {
  const activeEmployees = employees.filter(e => e.active !== false && e.branch_id === state.currentBranchId);
  const selectedEmployee = employee(shift?.employee_id) || activeEmployees[0];
  const selectedRole = shift?.role || selectedEmployee?.operational_role || "front_staff";
  openModal(`
    <div class="modal-head"><h3>${shift ? "Edit Shift" : "Add Shift"}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="shiftForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Employee</label><select name="employee_id" id="shiftEmployee" required>${activeEmployees.map(e => `<option value="${esc(e.id)}" data-role="${esc(e.operational_role || "front_staff")}" ${e.id === shift?.employee_id ? "selected" : ""}>${esc(employeeLabel(e))}</option>`).join("")}</select></div>
          <div><label>Shift Date</label><input name="shift_date" type="date" class="input" value="${esc(shift?.shift_date || view.start || today())}" required></div>
          <div><label>Start</label><input name="start_time" type="time" class="input" value="${esc((shift?.start_time || "10:00").slice(0, 5))}" required></div>
          <div><label>End</label><input name="end_time" type="time" class="input" value="${esc((shift?.end_time || "18:00").slice(0, 5))}" required></div>
          <div><label>Role For This Shift</label><select name="role" id="shiftRole">${roleOptions(selectedRole)}</select></div>
          <div><label>Status</label><select name="status"><option value="planned" ${shift?.status !== "cancelled" ? "selected" : ""}>Planned</option><option value="cancelled" ${shift?.status === "cancelled" ? "selected" : ""}>Cancelled</option></select></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2">${esc(shift?.notes || "")}</textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div>
    </form>
  `);
  $("shiftEmployee").onchange = e => {
    const opt = e.target.selectedOptions[0];
    $("shiftRole").value = opt?.dataset.role || "front_staff";
  };
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

function openSaveTemplateModal() {
  const days = weekDays(view.start);
  const rows = shifts.filter(s => s.status !== "cancelled" && days.includes(s.shift_date));
  if (!rows.length) return toast("Add shifts before saving a template.", "error");
  openModal(`
    <div class="modal-head"><h3>Save Week Template</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="saveTemplateForm">
      <div class="modal-body">
        <div class="form-grid">
          <div class="full"><label>Template Name</label><input name="name" class="input" value="Standard Week" required></div>
          <div class="full"><label>Notes</label><textarea name="notes" class="input" rows="2"></textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Save Template</button></div>
    </form>
  `);
  $("saveTemplateForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const template = await insertRow("shift_templates", {
        branch_id: state.currentBranchId,
        name: fd.get("name"),
        notes: fd.get("notes") || null,
        active: true,
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      });
      const payload = rows.map(s => ({
        template_id: template.id,
        weekday: weekdayNumber(s.shift_date),
        employee_id: s.employee_id,
        start_time: s.start_time,
        end_time: s.end_time,
        role: s.role || employee(s.employee_id)?.operational_role || null,
        notes: s.notes || null,
      }));
      const { error } = await state.db.from("shift_template_lines").insert(payload);
      if (error) throw error;
      toast("Shift template saved.", "ok");
      closeModal();
      renderShifts();
    } catch (err) {
      toast("Template save failed: " + err.message, "error");
    }
  };
}

function openApplyTemplateModal() {
  if (!templates.length) return toast("No templates yet. Save a week as a template first.", "error");
  openModal(`
    <div class="modal-head"><h3>Apply Shift Template</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="applyTemplateForm">
      <div class="modal-body">
        <div class="form-grid">
          <div><label>Template</label><select name="template_id">${templates.filter(t => t.active !== false).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select></div>
          <div><label>Week Starting</label><input name="week_start" type="date" class="input" value="${esc(weekDays(view.start)[0])}" required></div>
          <div class="full"><label><input name="replace" type="checkbox" checked> Clear existing planned shifts for this week first</label></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">Apply</button></div>
    </form>
  `);
  $("applyTemplateForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const templateId = fd.get("template_id");
    const week = weekDays(fd.get("week_start"));
    const lines = templateLines.filter(l => l.template_id === templateId);
    if (!lines.length) return toast("This template has no shifts.", "error");
    try {
      if (fd.get("replace") === "on") {
        const { error } = await state.db
          .from("shift_schedules")
          .delete()
          .eq("branch_id", state.currentBranchId)
          .eq("status", "planned")
          .in("shift_date", week);
        if (error) throw error;
      }
      const payload = lines.map(line => ({
        employee_id: line.employee_id,
        branch_id: state.currentBranchId,
        shift_date: week[Number(line.weekday || 1) - 1],
        start_time: line.start_time,
        end_time: line.end_time,
        role: line.role,
        notes: line.notes,
        status: "planned",
        created_by: state.user.id,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await state.db.from("shift_schedules").insert(payload);
      if (error) throw error;
      toast("Template applied.", "ok");
      closeModal();
      view.start = week[0];
      renderShifts();
    } catch (err) {
      toast("Template apply failed: " + err.message, "error");
    }
  };
}

function roleOptions(selected) {
  return ROLE_OPTIONS.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
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

function weekdayNumber(date) {
  const d = new Date(`${date}T00:00:00`);
  return ((d.getDay() + 6) % 7) + 1;
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

function minutesToTime(value) {
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeRange(rows) {
  const starts = rows.map(s => minutes(s.start_time));
  const ends = rows.map(s => minutes(s.end_time));
  const start = Math.max(0, Math.min(...starts, 8 * 60) - 60);
  const end = Math.min(24 * 60, Math.max(...ends, 23 * 60) + 60);
  return { start, end, width: Math.max(900, ((end - start) / 60) * 92) };
}

function minuteLeft(value, range) {
  return ((value - range.start) / (range.end - range.start)) * range.width;
}

function shiftHours(s) {
  return Math.max(0, minutes(s.end_time) - minutes(s.start_time)) / 60;
}

function shiftCost(s) {
  return shiftHours(s) * Number(employee(s.employee_id)?.hourly_rate || 0);
}
