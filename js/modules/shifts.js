import { state, isManager, canSeeFinancials } from "../state.js";
import { $, esc, money, showError, toast, openModal, closeModal, today, dateKey, dateKeyInZone, businessDayForTimestamp, formatDateTimeMelbourne, formatTimeMelbourne, formatDuration } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";

let employees = [];
let shifts = [];
let timeEntries = [];
let templates = [];
let templateLines = [];
let view = { start: today(), mode: "week" };
let dragState = null;

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
  timeEntries = (await safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []))
    .filter(entry => entry.status !== "cancelled");
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
  const rows = plannerRows(days);
  const planned = rowSummary(rows, "planned");
  const actual = rowSummary(rows, "actual");
  const warnings = buildWarnings(days, rows);
  const range = timeRange(rows);
  $("shiftPlanner").innerHTML = `
    <div class="grid cards planner-summary" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Branch</div><div><b>${esc(branchName(state.currentBranchId))}</b></div></div>
      <div class="card"><div class="stat-title">Planned</div><div><b>${planned.count}</b> shifts</div><small class="muted">${planned.hours.toFixed(2)} hours</small></div>
      ${canSeeFinancials() ? `<div class="card"><div class="stat-title">Planned Cost</div><div><b>${money(planned.cost)}</b></div></div>` : ""}
      <div class="card"><div class="stat-title">Actual</div><div><b>${actual.count}</b> entries</div><small class="muted">${actual.hours.toFixed(2)} hours</small></div>
      ${canSeeFinancials() ? `<div class="card"><div class="stat-title">Actual Cost</div><div><b>${money(actual.cost)}</b></div></div>` : ""}
    </div>
    ${warnings.length ? `<div class="errorbox">${warnings.map(esc).join("<br>")}</div>` : ""}
    <div class="shift-timeline-wrap">
      ${renderTimeHeader(range)}
      ${days.map(day => renderTimelineDay(day, rows.filter(s => s.shift_date === day), range)).join("")}
    </div>
  `;
  document.querySelectorAll(".shift-pill:not(.actual)").forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.dragged === "true") {
        btn.dataset.dragged = "";
        return;
      }
      openShiftModal(shifts.find(s => s.id === btn.dataset.id));
    };
    btn.onpointerdown = startShiftDrag;
  });
  document.querySelectorAll(".shift-pill.actual").forEach(btn => {
    btn.onclick = () => openActualShiftModal(timeEntries.find(entry => entry.id === btn.dataset.id));
  });
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
  const planned = rowSummary(dayShifts, "planned");
  const actual = rowSummary(dayShifts, "actual");
  return `
    <section class="shift-time-row" style="--time-width:${range.width}px;--row-height:${rowHeight}px">
      <div class="shift-day-label">
        <b>${esc(dayLabel(day))}</b>
        <span>${esc(day)}</span>
        <small>Planned: ${planned.count} shifts / ${planned.hours.toFixed(2)}h${canSeeFinancials() ? ` / ${money(planned.cost)}` : ""}</small>
        <small>Actual: ${actual.count} entries / ${actual.hours.toFixed(2)}h${canSeeFinancials() ? ` / ${money(actual.cost)}` : ""}</small>
      </div>
      <div class="shift-time-lane">
        ${layout.items.map(item => {
          const s = item.shift;
          const e = employee(s.employee_id);
          const role = s.role || e?.operational_role || "front_staff";
          const start = startMinutesAbs(s);
          const end = endMinutesAbs(s);
          const left = minuteLeft(start, range);
          const width = Math.max(60, minuteLeft(end, range) - left);
          return `<button class="shift-pill role-${esc(role)} ${s.source === "actual" ? "actual" : ""}" data-id="${esc(s.id)}" data-range-start="${range.start}" data-range-end="${range.end}" data-range-width="${range.width}" style="left:${left}px;top:${8 + item.lane * 46}px;width:${width}px">
            ${s.source === "actual" ? "" : '<span class="shift-resize left" data-edge="left"></span>'}
            <b>${esc(employeeLabel(e))}</b>
            <span>${esc(timeShort(s.start_time))}-${esc(timeShort(s.end_time))} - ${esc(roleLabel(role))}${s.source === "actual" ? " - Actual" : ""}</span>
            ${s.source === "actual" ? "" : '<span class="shift-resize right" data-edge="right"></span>'}
          </button>`;
        }).join("") || '<div class="muted" style="padding:12px">No shifts planned.</div>'}
      </div>
    </section>
  `;
}

function rowSummary(rows, source) {
  const scoped = rows.filter(row => row.source === source);
  return {
    count: scoped.length,
    hours: scoped.reduce((sum, row) => sum + shiftHours(row), 0),
    cost: scoped.reduce((sum, row) => sum + shiftCost(row), 0),
  };
}

function plannerRows(days) {
  return days.flatMap(day => [...plannedRowsForDay(day), ...actualRowsForDay(day)]);
}

function plannedRowsForDay(day) {
  return shifts
    .filter(s => s.status !== "cancelled" && s.shift_date === day)
    .map(s => ({ ...s, source: "planned" }));
}

function actualRowsForDay(day) {
  return timeEntries
    .filter(entry => entry.status !== "cancelled" && entryBusinessDay(entry) === day)
    .map(entry => {
      const e = employee(entry.employee_id);
      const start = toLocalTime(entry.clock_in_at || entry.created_at);
      const end = entry.clock_out_at ? toLocalTime(entry.clock_out_at) : timeShort(start);
      const startAbs = actualMinutesAbs(entry.clock_in_at || entry.created_at, day);
      const endAbs = entry.clock_out_at ? actualMinutesAbs(entry.clock_out_at, day) : startAbs;
      return {
        id: entry.id,
        employee_id: entry.employee_id,
        shift_date: entryBusinessDay(entry),
        start_time: start,
        end_time: entry.clock_out_at ? end : start,
        start_abs: startAbs,
        end_abs: Math.max(endAbs, startAbs),
        role: e?.operational_role || "front_staff",
        status: entry.status,
        source: "actual",
        paid_minutes: entry.paid_minutes,
        clock_in_at: entry.clock_in_at,
        clock_out_at: entry.clock_out_at,
        break_minutes: entry.break_minutes,
      };
    });
}

function entryBusinessDay(entry) {
  const shift = shifts.find(s => s.id === entry.shift_id);
  return shift?.shift_date || businessDayForTimestamp(entry.clock_in_at || entry.created_at);
}

function layoutShifts(dayShifts) {
  const sorted = [...dayShifts].sort((a, b) => startMinutesAbs(a) - startMinutesAbs(b));
  const laneEnds = [];
  const items = sorted.map(shift => {
    let lane = laneEnds.findIndex(end => end <= startMinutesAbs(shift));
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = endMinutesAbs(shift);
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
      <div class="modal-foot">
        <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
        ${shift ? `<button type="button" class="btn red" id="deleteShiftBtn">Delete Shift</button>` : ""}
        <button class="btn">Save</button>
      </div>
    </form>
  `);
  $("shiftEmployee").onchange = e => {
    const opt = e.target.selectedOptions[0];
    $("shiftRole").value = opt?.dataset.role || "front_staff";
  };
  if (shift && $("deleteShiftBtn")) $("deleteShiftBtn").onclick = async () => {
    if (!confirm("Delete this planned shift from the planner?")) return;
    try {
      await updateRow("shift_schedules", shift.id, { status: "cancelled", updated_at: new Date().toISOString() });
      toast("Shift deleted from planner.", "ok");
      closeModal();
      renderShifts();
    } catch (err) {
      toast("Shift delete failed: " + err.message, "error");
    }
  };
  $("shiftForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
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

function openActualShiftModal(entry) {
  if (!entry) return;
  const e = employee(entry.employee_id);
  const shift = shifts.find(s => s.id === entry.shift_id);
  const paidMinutes = Number(entry.paid_minutes || 0);
  openModal(`
    <div class="modal-head"><h3>Actual Shift</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div><label>Employee</label><div>${esc(employeeLabel(e))}</div></div>
        <div><label>Status</label><div>${esc(entry.status || "-")}</div></div>
        <div><label>Business Day</label><div>${esc(entryBusinessDay(entry))}</div></div>
        <div><label>Paid Time</label><div>${esc(formatDuration(paidMinutes))}</div></div>
        <div><label>Clock In</label><div>${esc(formatDateTimeMelbourne(entry.clock_in_at || entry.created_at))}</div></div>
        <div><label>Clock Out</label><div>${entry.clock_out_at ? esc(formatDateTimeMelbourne(entry.clock_out_at)) : "-"}</div></div>
        <div><label>Planned Shift</label><div>${shift ? `${esc(shift.shift_date)} ${esc(timeShort(shift.start_time))}-${esc(timeShort(shift.end_time))}` : "-"}</div></div>
        <div><label>Role</label><div>${esc(roleLabel(shift?.role || e?.operational_role))}</div></div>
        <div class="full"><label>Clock In Reason</label><div>${esc(entry.clock_in_reason || "-")}</div></div>
        <div class="full"><label>Clock Out Reason</label><div>${esc(entry.clock_out_reason || "-")}</div></div>
      </div>
    </div>
    <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
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
          <div class="full"><label><input name="replace" type="checkbox" checked> Cancel existing planned shifts for this week first</label></div>
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
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
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

function startShiftDrag(event) {
  if (event.button !== 0) return;
  const pill = event.currentTarget;
  const shift = shifts.find(s => s.id === pill.dataset.id);
  if (!shift) return;
  const lane = pill.closest(".shift-time-lane");
  const edge = event.target.closest(".shift-resize")?.dataset.edge || "move";
  dragState = {
    pill,
    shift,
    lane,
    edge,
    startX: event.clientX,
    originalLeft: parseFloat(pill.style.left || "0"),
    originalWidth: parseFloat(pill.style.width || "60"),
    rangeStart: Number(pill.dataset.rangeStart),
    rangeEnd: Number(pill.dataset.rangeEnd),
    rangeWidth: Number(pill.dataset.rangeWidth),
    moved: false,
  };
  pill.setPointerCapture(event.pointerId);
  pill.classList.add("dragging");
  window.addEventListener("pointermove", moveShiftDrag);
  window.addEventListener("pointerup", endShiftDrag, { once: true });
}

function moveShiftDrag(event) {
  if (!dragState) return;
  const dx = event.clientX - dragState.startX;
  if (Math.abs(dx) > 3) dragState.moved = true;
  let left = dragState.originalLeft;
  let width = dragState.originalWidth;
  if (dragState.edge === "move") {
    left = dragState.originalLeft + dx;
  } else if (dragState.edge === "left") {
    left = dragState.originalLeft + dx;
    width = dragState.originalWidth - dx;
  } else if (dragState.edge === "right") {
    width = dragState.originalWidth + dx;
  }
  const minWidth = pixelsForMinutes(30, dragState);
  left = Math.max(0, Math.min(left, dragState.rangeWidth - minWidth));
  width = Math.max(minWidth, Math.min(width, dragState.rangeWidth - left));
  dragState.pill.style.left = `${left}px`;
  dragState.pill.style.width = `${width}px`;
}

async function endShiftDrag() {
  if (!dragState) return;
  window.removeEventListener("pointermove", moveShiftDrag);
  const stateCopy = dragState;
  dragState = null;
  stateCopy.pill.classList.remove("dragging");
  if (!stateCopy.moved) return;
  stateCopy.pill.dataset.dragged = "true";
  const start = snapMinutes(minutesForLeft(parseFloat(stateCopy.pill.style.left || "0"), stateCopy));
  const end = snapMinutes(minutesForLeft(parseFloat(stateCopy.pill.style.left || "0") + parseFloat(stateCopy.pill.style.width || "0"), stateCopy));
  const payload = {
    start_time: minutesToTime(start % 1440),
    end_time: minutesToTime(end % 1440),
    updated_at: new Date().toISOString(),
  };
  try {
    await updateRow("shift_schedules", stateCopy.shift.id, payload);
    const local = shifts.find(s => s.id === stateCopy.shift.id);
    if (local) Object.assign(local, payload);
    toast("Shift updated.", "ok");
    renderShiftPlanner();
  } catch (err) {
    toast("Shift update failed: " + err.message, "error");
    renderShiftPlanner();
  }
}

function pixelsForMinutes(value, range) {
  return value / (range.rangeEnd - range.rangeStart) * range.rangeWidth;
}

function minutesForLeft(left, range) {
  return range.rangeStart + (left / range.rangeWidth) * (range.rangeEnd - range.rangeStart);
}

function snapMinutes(value) {
  return Math.round(value / 15) * 15;
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
    return dateKey(x);
  });
}

function weekdayNumber(date) {
  const d = new Date(`${date}T00:00:00`);
  return ((d.getDay() + 6) % 7) + 1;
}

function dateShift(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateKey(d);
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

function minutesAbs(value) {
  return minutes(value);
}

function startMinutesAbs(shift) {
  return Number(shift.start_abs ?? minutes(shift.start_time));
}

function endMinutesAbs(shift) {
  if (shift.end_abs !== undefined && shift.end_abs !== null) return Number(shift.end_abs);
  const start = minutes(shift.start_time);
  const end = minutes(shift.end_time);
  return end <= start ? end + 1440 : end;
}

function actualMinutesAbs(value, businessDay) {
  const localTime = toLocalTime(value);
  const localDate = dateKeyInZone(value);
  return minutes(localTime) + (localDate > businessDay ? 1440 : 0);
}

function minutesToTime(value) {
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeRange(rows) {
  if (!rows.length) return { start: 8 * 60, end: 27 * 60, width: 19 * 92 };
  const starts = rows.map(s => startMinutesAbs(s));
  const ends = rows.map(s => endMinutesAbs(s));
  const start = Math.max(0, Math.min(...starts, 8 * 60) - 60);
  const end = Math.max(27 * 60, Math.max(...ends, 23 * 60) + 60);
  return { start, end, width: Math.max(900, ((end - start) / 60) * 92) };
}

function minuteLeft(value, range) {
  return ((value - range.start) / (range.end - range.start)) * range.width;
}

function shiftHours(s) {
  if (s.source === "actual" && Number(s.paid_minutes || 0) > 0) return Number(s.paid_minutes || 0) / 60;
  if (s.source === "actual" && s.clock_in_at && s.clock_out_at) {
    const total = Math.max(0, Math.round((new Date(s.clock_out_at) - new Date(s.clock_in_at)) / 60000));
    return Math.max(0, total - Number(s.break_minutes || 0)) / 60;
  }
  return Math.max(0, endMinutesAbs(s) - startMinutesAbs(s)) / 60;
}

function shiftCost(s) {
  return shiftHours(s) * Number(employee(s.employee_id)?.hourly_rate || 0);
}

function toLocalTime(value) {
  return formatTimeMelbourne(value);
}
