import { state, isManager } from "../state.js";
import { $, esc, showError, toast, openModal, closeModal, businessToday, businessDayForTimestamp, formatDateTimeMelbourne, formatDuration } from "../utils.js";
import { safeSelect, insertRow, updateRow } from "../services/db.js";

let employees = [];
let shifts = [];
let entries = [];

const TEST_MODE = true;
const GRACE_MINUTES = 5;
const CLOCK_ALERT_MINUTES = 60;
const employee = id => employees.find(e => e.id === id);
const employeeByNumber = number => employees.find(e => String(e.employee_number).trim() === String(number).trim() && e.active !== false);
const branchName = id => (state.branches || []).find(b => b.id === id)?.name || id || "-";
const employeeDisplay = e => isManager() ? `${e?.full_name || "Employee"} (#${e?.employee_number || "-"})` : `Employee #${e?.employee_number || "-"}`;

async function loadClockData() {
  employees = await safeSelect("employees", "*", { order: "employee_number" }).catch(() => []);
  shifts = await safeSelect("shift_schedules", "*", { eq: { branch_id: state.currentBranchId }, order: "shift_date" }).catch(() => []);
  entries = await safeSelect("time_entries", "*", { eq: { branch_id: state.currentBranchId }, order: "created_at", ascending: false }).catch(() => []);
}

export async function renderTimeClock() {
  const content = $("content");
  content.innerHTML = '<div class="card">Loading time clock...</div>';
  try {
    await loadClockData();
    content.innerHTML = `
      <div class="card">
        <div class="section-head">
          <h2>Time Clock</h2>
          <div class="toolbar">
            <input id="clockEmployeeNumber" class="input" inputmode="numeric" placeholder="Employee number">
            <button class="btn green" id="clockInBtn">Clock In</button>
            <button class="btn gold" id="clockOutBtn">Clock Out</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:12px">Testing mode is active: GPS and late/early blocking are prepared but not enforced yet.</div>
        <div id="clockPanel"></div>
      </div>
    `;
    $("clockInBtn").onclick = () => handleClock("in");
    $("clockOutBtn").onclick = () => handleClock("out");
    renderClockPanel();
  } catch (err) {
    content.innerHTML = showError("Could not load Time Clock. " + err.message);
  }
}

function renderClockPanel() {
  const day = businessToday();
  const todayEntries = entries.filter(e => entryBusinessDay(e) === day);
  const openEntries = entries.filter(e => e.status === "clocked_in");
  $("clockPanel").innerHTML = `
    <div class="grid cards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      <div class="card"><div class="stat-title">Branch</div><div><b>${esc(branchName(state.currentBranchId))}</b></div></div>
      <div class="card"><div class="stat-title">Clocked In</div><div><b>${openEntries.length}</b></div></div>
      <div class="card"><div class="stat-title">Today Entries</div><div><b>${todayEntries.length}</b></div></div>
      <div class="card"><div class="stat-title">Testing Mode</div><div><b>On</b></div></div>
    </div>
    ${isManager() ? renderManagerEntries() : renderStaffHelp()}
  `;
}

function renderStaffHelp() {
  return `
    <div class="card">
      <div class="stat-title">Employee privacy</div>
      <div>Use your employee number to clock in or out. Staff screens do not show other employees' names.</div>
    </div>
  `;
}

function renderManagerEntries() {
  const rows = entries.slice(0, 80);
  const openRows = entries
    .filter(entry => entry.status === "clocked_in")
    .sort((a, b) => new Date(a.clock_in_at || a.created_at) - new Date(b.clock_in_at || b.created_at));
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="section-head"><h3 style="margin:0">Currently Clocked In</h3></div>
      <table>
        <thead><tr><th>Employee</th><th>Planned Shift</th><th>Clock In</th><th>Time In</th><th>Reason</th><th></th></tr></thead>
        <tbody>
          ${openRows.map(entry => {
            const e = employee(entry.employee_id);
            const shift = shifts.find(s => s.id === entry.shift_id);
            return `<tr>
              <td><b>${esc(employeeDisplay(e))}</b></td>
              <td>${shift ? `${esc(shift.shift_date)} ${esc(timeShort(shift.start_time))}-${esc(timeShort(shift.end_time))}` : '<span class="badge gold">No shift</span>'}</td>
              <td>${esc(formatDateTime(entry.clock_in_at))}</td>
              <td><b>${esc(elapsedSince(entry.clock_in_at))}</b></td>
              <td>${esc(entry.clock_in_reason || "")}</td>
              <td><button class="btn secondary small view-time-entry" data-id="${esc(entry.id)}">View</button></td>
            </tr>`;
          }).join("") || '<tr><td colspan="6" class="muted">Nobody is clocked in right now.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="section-head"><h3 style="margin:0">Recent Time Entries</h3></div>
    <table>
      <thead><tr><th>Employee</th><th>Shift</th><th>Clock In</th><th>Clock Out</th><th>Paid</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(entry => {
          const e = employee(entry.employee_id);
          const shift = shifts.find(s => s.id === entry.shift_id);
          return `<tr>
            <td><b>${esc(employeeDisplay(e))}</b></td>
            <td>${shift ? `${esc(shift.shift_date)} ${esc(timeShort(shift.start_time))}-${esc(timeShort(shift.end_time))}` : '<span class="badge gold">No shift</span>'}</td>
            <td>${esc(formatDateTime(entry.clock_in_at))}<div class="muted">${esc(entry.clock_in_reason || "")}</div></td>
            <td>${esc(formatDateTime(entry.clock_out_at))}<div class="muted">${esc(entry.clock_out_reason || "")}</div></td>
            <td>${minutesToHours(entry.paid_minutes)}</td>
            <td><span class="badge ${entry.status === "clocked_out" ? "green" : "blue"}">${esc(entry.status)}</span></td>
            <td><button class="btn secondary small view-time-entry" data-id="${esc(entry.id)}">View</button></td>
          </tr>`;
        }).join("") || '<tr><td colspan="7" class="muted">No time entries yet.</td></tr>'}
      </tbody>
    </table>
  `;
}

async function handleClock(direction) {
  const number = $("clockEmployeeNumber").value.trim();
  if (!number) return toast("Enter employee number.", "error");
  const e = employeeByNumber(number);
  if (!e) return toast("Employee number not found or inactive.", "error");
  if (e.branch_id !== state.currentBranchId) return toast("Employee belongs to a different branch.", "error");
  if (direction === "in") return clockIn(e);
  return clockOut(e);
}

async function clockIn(e) {
  const open = entries.find(entry => entry.employee_id === e.id && entry.status === "clocked_in");
  if (open) return toast("This employee is already clocked in.", "error");
  const shift = shiftForEmployeeToday(e.id);
  const timing = shift ? timingStatus(shift, "in") : { requiresReason: false, label: "No planned shift" };
  openClockReasonModal({
    title: "Clock In",
    employee: e,
    shift,
    timing,
    required: !TEST_MODE && timing.requiresReason,
    onSave: async reason => {
      try {
        const entry = await insertRow("time_entries", {
          employee_id: e.id,
          shift_id: shift?.id || null,
          branch_id: state.currentBranchId,
          clock_in_at: new Date().toISOString(),
          clock_in_reason: reason || null,
          status: "clocked_in",
          created_by: state.user.id,
          updated_at: new Date().toISOString(),
        });
        await maybeCreateClockAlert(entry, e, shift, timing, reason).catch(() => {});
        toast("Clock in saved.", "ok");
        closeModal();
        renderTimeClock();
      } catch (err) {
        toast("Clock in failed: " + err.message, "error");
      }
    },
  });
}

async function clockOut(e) {
  const open = entries.find(entry => entry.employee_id === e.id && entry.status === "clocked_in");
  if (!open) return toast("No open clock-in found for this employee.", "error");
  const shift = shifts.find(s => s.id === open.shift_id) || shiftForEmployeeToday(e.id);
  const timing = shift ? timingStatus(shift, "out") : { requiresReason: false, label: "No planned shift" };
  openClockReasonModal({
    title: "Clock Out",
    employee: e,
    shift,
    timing,
    required: !TEST_MODE && timing.requiresReason,
    onSave: async reason => {
      try {
        const now = new Date();
        const total = Math.max(0, Math.round((now - new Date(open.clock_in_at)) / 60000));
        const paid = Math.max(0, total - Number(open.break_minutes || 0));
        await updateRow("time_entries", open.id, {
          clock_out_at: now.toISOString(),
          clock_out_reason: reason || null,
          status: "clocked_out",
          total_minutes: total,
          paid_minutes: paid,
          updated_at: now.toISOString(),
        });
        toast("Clock out saved.", "ok");
        closeModal();
        renderTimeClock();
      } catch (err) {
        toast("Clock out failed: " + err.message, "error");
      }
    },
  });
}

function openClockReasonModal({ title, employee: e, shift, timing, required, onSave }) {
  openModal(`
    <div class="modal-head"><h3>${esc(title)}</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <form id="clockReasonForm">
      <div class="modal-body">
        <div class="grid cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
          <div class="card"><div class="stat-title">Employee</div><div><b>${esc(employeeDisplay(e))}</b></div></div>
          <div class="card"><div class="stat-title">Shift</div><div><b>${shift ? `${esc(timeShort(shift.start_time))}-${esc(timeShort(shift.end_time))}` : "No shift"}</b></div></div>
          <div class="card"><div class="stat-title">Timing</div><div><b>${esc(timing.label)}</b></div></div>
        </div>
        <div class="form-grid">
          <div class="full"><label>Reason${required ? " (required)" : ""}</label><textarea name="reason" class="input" rows="3" placeholder="${TEST_MODE ? "Optional during testing" : "Required when outside the 5-minute buffer"}"></textarea></div>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn">${esc(title)}</button></div>
    </form>
  `);
  $("clockReasonForm").onsubmit = e => {
    e.preventDefault();
    const reason = String(new FormData(e.target).get("reason") || "").trim();
    if (required && !reason) return toast("Reason is required.", "error");
    onSave(reason);
  };
}

function shiftForEmployeeToday(employeeId) {
  const day = businessToday();
  return shifts
    .filter(s => s.employee_id === employeeId && s.shift_date === day && s.status !== "cancelled")
    .sort((a, b) => Math.abs(minutesNow() - minutes(a.start_time)) - Math.abs(minutesNow() - minutes(b.start_time)))[0];
}

function timingStatus(shift, direction) {
  const planned = minutes(direction === "in" ? shift.start_time : shift.end_time);
  const diff = minutesNow() - planned;
  const abs = Math.abs(diff);
  const word = diff > 0 ? "late" : "early";
  return {
    requiresReason: abs > GRACE_MINUTES,
    minutesDiff: diff,
    absMinutes: abs,
    label: abs <= GRACE_MINUTES ? "Within 5m buffer" : `${formatDuration(abs)} ${word}`,
  };
}

async function maybeCreateClockAlert(entry, employeeRow, shift, timing, reason) {
  const noShift = !shift;
  const farFromShift = shift && Number(timing.absMinutes || 0) > CLOCK_ALERT_MINUTES;
  if (!noShift && !farFromShift) return;
  const title = noShift ? "Unplanned clock-in" : "Clock-in far from planned shift";
  const detail = {
    employee_id: employeeRow.id,
    employee_number: employeeRow.employee_number,
    employee_name: employeeRow.full_name,
    time_entry_id: entry.id,
    clock_in_at: entry.clock_in_at,
    branch_id: state.currentBranchId,
    shift_id: shift?.id || null,
    planned_start_time: shift?.start_time || null,
    planned_end_time: shift?.end_time || null,
    minutes_from_planned_start: shift ? timing.minutesDiff : null,
    reason: reason || null,
  };
  await state.db.from("alerts").insert({
    branch_id: state.currentBranchId,
    alert_type: noShift ? "TIME_CLOCK_UNPLANNED" : "TIME_CLOCK_FAR_FROM_SHIFT",
    title,
    detail,
    reference_id: entry.id,
    reference_type: "time_clock",
    status: "open",
  });
}

function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function minutes(value) {
  const [h, m] = timeShort(value).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function timeShort(value) {
  return String(value || "").slice(0, 5);
}

function formatDateTime(value) {
  return formatDateTimeMelbourne(value);
}

function minutesToHours(value) {
  return formatDuration(value);
}

function elapsedSince(value) {
  if (!value) return "-";
  const total = Math.max(0, Math.round((new Date() - new Date(value)) / 60000));
  return formatDuration(total);
}

function entryBusinessDay(entry) {
  const shift = shifts.find(s => s.id === entry.shift_id);
  return shift?.shift_date || businessDayForTimestamp(entry.clock_in_at || entry.created_at);
}

document.addEventListener("click", e => {
  const btn = e.target.closest?.(".view-time-entry");
  if (!btn) return;
  const entry = entries.find(row => row.id === btn.dataset.id);
  if (!entry) return;
  const eRow = employee(entry.employee_id);
  openModal(`
    <div class="modal-head"><h3>Time Entry</h3><button class="btn secondary small" onclick="closeModal()">x</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div><label>Employee</label><input class="input" value="${esc(employeeDisplay(eRow))}" disabled></div>
        <div><label>Status</label><input class="input" value="${esc(entry.status)}" disabled></div>
        <div><label>Clock In</label><input class="input" value="${esc(formatDateTime(entry.clock_in_at))}" disabled></div>
        <div><label>Clock Out</label><input class="input" value="${esc(formatDateTime(entry.clock_out_at))}" disabled></div>
        <div class="full"><label>Clock In Reason</label><textarea class="input" rows="2" disabled>${esc(entry.clock_in_reason || "")}</textarea></div>
        <div class="full"><label>Clock Out Reason</label><textarea class="input" rows="2" disabled>${esc(entry.clock_out_reason || "")}</textarea></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">Close</button></div>
  `);
});
