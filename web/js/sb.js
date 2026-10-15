import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.FMS_CONFIG || {};
export const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT");

export const sb = configured
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// Call a database function; throws Error with the database message (Hinglish text from SQL)
export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message || String(error));
  return data;
}

// Run a select and throw on error
export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw new Error(error.message || String(error));
  return data;
}

// Fetch every row (Supabase returns max 1000 per request)
export async function fetchAll(makeQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const rows = await q(makeQuery().range(from, from + pageSize - 1));
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
