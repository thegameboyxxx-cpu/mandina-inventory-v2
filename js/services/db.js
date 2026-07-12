import { state } from "../state.js";

const PAGE_SIZE = 1000;

function applySelectOptions(query, options) {
  if (options.eq) {
    for (const [key, value] of Object.entries(options.eq)) query = query.eq(key, value);
  }
  if (options.order) query = query.order(options.order, { ascending: options.ascending ?? true });
  return query;
}

export async function safeSelect(table, columns = "*", options = {}) {
  const pageSize = Number(options.pageSize || PAGE_SIZE);
  const all = [];

  for (let from = 0; ; from += pageSize) {
    let query = state.db.from(table).select(columns);
    query = applySelectOptions(query, options).range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}

export async function insertRow(table, payload) {
  const { data, error } = await state.db.from(table).insert(payload).select("*").single();
  if (error) throw error;
  return data;
}

export async function updateRow(table, id, payload) {
  const { data, error } = await state.db.from(table).update(payload).eq("id", id).select("*").single();
  if (error) throw error;
  return data;
}

export async function deleteRows(table, column, value) {
  const { error } = await state.db.from(table).delete().eq(column, value);
  if (error) throw error;
}
