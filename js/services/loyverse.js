import { state } from "../state.js";

export async function loyverseSync(action, payload) {
  const { data, error } = await state.db.functions.invoke("loyverse-sync", {
    body: { action, ...payload },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}
