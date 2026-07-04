import { CONFIG } from "../config.js";
import { state } from "../state.js";

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
  const primary = errorText(body?.error || body?.message);
  const usefulPrimary = primary && primary !== "{}" && primary !== "[]" && primary !== "[object Object]"
    ? primary
    : fallback;
  const parts = [
    usefulPrimary,
    body?.detail ? `Detail: ${errorText(body.detail)}` : "",
    body?.hint ? `Hint: ${errorText(body.hint)}` : "",
    body?.code ? `Code: ${errorText(body.code)}` : "",
    primary && primary !== usefulPrimary ? `Raw: ${primary}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

export async function callFunction(functionName, payload, fallbackLabel = "Function request failed") {
  const { data: sessionData, error: sessionError } = await state.db.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error("You must be logged in.");

  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }

  if (!res.ok) throw new Error(functionErrorMessage(data, `${fallbackLabel} (${res.status}).`));
  if (data?.error) throw new Error(functionErrorMessage(data, fallbackLabel));
  return data;
}
