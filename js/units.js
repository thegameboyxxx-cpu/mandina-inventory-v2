import { esc } from "./utils.js";

export const UNITS = [
  { value: "kg", label: "kg" },
  { value: "gram", label: "gram" },
  { value: "litre", label: "litre" },
  { value: "ml", label: "ml" },
  { value: "piece", label: "piece" },
  { value: "plate", label: "plate" },
  { value: "portion", label: "portion" },
  { value: "serve", label: "serve" },
  { value: "container", label: "container" },
  { value: "bag", label: "bag" },
  { value: "box", label: "box" },
  { value: "carton", label: "carton" },
  { value: "tray", label: "tray" },
  { value: "bucket", label: "bucket" },
  { value: "bottle", label: "bottle" },
  { value: "pack", label: "pack" },
  { value: "roll", label: "roll" },
  { value: "can", label: "can" },
  { value: "tin", label: "tin" },
  { value: "drum", label: "drum" },
  { value: "tub", label: "tub" },
  { value: "bunch", label: "bunch" },
];

export function unitOptions(selected = "", includeBlank = true) {
  const current = String(selected || "");
  const known = UNITS.some(unit => unit.value === current);
  const customOption = current && !known
    ? `<option value="${esc(current)}" selected>${esc(current)} (existing)</option>`
    : "";

  return `${includeBlank ? '<option value="">-- Select unit --</option>' : ""}${customOption}${UNITS.map(unit => (
    `<option value="${esc(unit.value)}" ${unit.value === current ? "selected" : ""}>${esc(unit.label)}</option>`
  )).join("")}`;
}

export function unitSelect(name, selected = "", attrs = "") {
  return `<select name="${esc(name)}" ${attrs}>${unitOptions(selected)}</select>`;
}
