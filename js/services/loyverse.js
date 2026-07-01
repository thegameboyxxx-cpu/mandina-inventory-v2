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
  const parts = [
    errorText(body?.error || body?.message || fallback),
    body?.detail ? `Detail: ${errorText(body.detail)}` : "",
    body?.hint ? `Hint: ${errorText(body.hint)}` : "",
    body?.code ? `Code: ${errorText(body.code)}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

export async function loyverseSync(action, payload) {
  const { data, error } = await state.db.functions.invoke("loyverse-sync", {
    body: { action, ...payload },
  });
  if (error) {
    const context = error.context;
    if (context?.json) {
      try {
        const body = await context.json();
        throw new Error(functionErrorMessage(body, error.message));
      } catch (parseError) {
        if (parseError.message && parseError.message !== "Body is unusable") throw parseError;
      }
    }
    if (context?.text) {
      try {
        const text = await context.text();
        if (text) throw new Error(text);
      } catch (parseError) {
        if (parseError.message && parseError.message !== "Body is unusable") throw parseError;
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(functionErrorMessage(data, "Loyverse sync failed."));
  return data;
}
