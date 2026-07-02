export const MELBOURNE_TZ = "Australia/Melbourne";
export const BUSINESS_DAY_CUTOFF_HOUR = 5;

export const $ = id => document.getElementById(id);

export const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#039;",
}[char]));

export const money = value => Number(value || 0).toLocaleString("en-AU", {
  style: "currency",
  currency: "AUD",
});

export const qty = value => {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

export const dateKey = date => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
);

export const dateOnly = value => String(value || "").slice(0, 10);

export const today = () => dateKeyInZone(new Date());

export const businessToday = () => businessDayForTimestamp(new Date());

export function dateKeyInZone(value, timeZone = MELBOURNE_TZ) {
  const parts = dateTimeParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatDateTimeMelbourne(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-AU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: MELBOURNE_TZ,
  });
}

export function formatTimeMelbourne(value) {
  if (!value) return "00:00";
  const parts = dateTimeParts(value);
  return `${parts.hour}:${parts.minute}`;
}

export function businessDayForTimestamp(value, cutoffHour = BUSINESS_DAY_CUTOFF_HOUR) {
  if (!value) return today();
  const parts = dateTimeParts(value);
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) < cutoffHour ? dateShift(key, -1) : key;
}

export function dateShift(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function dateTimeParts(value, timeZone = MELBOURNE_TZ) {
  const date = value instanceof Date ? value : new Date(value);
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === "24" ? "00" : parts.hour,
    minute: parts.minute,
  };
}

export const showError = message => `<div class="errorbox">${esc(message)}</div>`;

export function toast(message, type = "info") {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  el.style.background = type === "error" ? "#9b1c13" : type === "ok" ? "#12663d" : "#22150e";
  setTimeout(() => el.classList.add("hidden"), Math.min(12000, Math.max(3500, String(message).length * 90)));
}

export function openModal(html) {
  $("modalRoot").innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
}

export function closeModal() {
  $("modalRoot").innerHTML = "";
}

window.closeModal = closeModal;
