import { state } from "../state.js";
import { CONFIG } from "../config.js";

function errorText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function functionErrorMessage(body, fallback) {
  const parts = [
    errorText(body?.error || body?.message || fallback),
    body?.detail ? `Detail: ${errorText(body.detail)}` : "",
    body?.hint ? `Hint: ${errorText(body.hint)}` : "",
    body?.code ? `Code: ${errorText(body.code)}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

export async function loyverseSync(action, payload) {
  const { data: sessionData, error: sessionError } = await state.db.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error("You must be logged in before syncing Loyverse.");

  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/loyverse-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }

  if (!res.ok) {
    throw new Error(functionErrorMessage(data, `Loyverse sync failed (${res.status}).`));
  }
  if (data?.error) throw new Error(functionErrorMessage(data, "Loyverse sync failed."));
  return data;
}
