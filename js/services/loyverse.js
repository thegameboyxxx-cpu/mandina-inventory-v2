import { state } from "../state.js";

export async function loyverseSync(action, payload) {
  const { data, error } = await state.db.functions.invoke("loyverse-sync", {
    body: { action, ...payload },
  });
  if (error) {
    const context = error.context;
    if (context?.json) {
      try {
        const body = await context.json();
        throw new Error(body?.error || body?.message || error.message);
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
  if (data?.error) throw new Error(data.error);
  return data;
}
