import { Pool } from "pg";

function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizePgIdentifier(value, fallback) {
  const normalized = normalizeText(value) || fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`非法的 PostgreSQL 标识符: ${normalized}`);
  }
  return normalized;
}

export function quotePgIdentifier(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

export function createDatabasePool(options = {}) {
  const connectionString =
    normalizeText(options.connectionString) || normalizeText(process.env.DATABASE_URL);
  if (!connectionString) {
    throw new Error("缺少 DATABASE_URL，无法连接 PostgreSQL。");
  }

  return new Pool({
    connectionString,
    max: Math.max(2, Number(process.env.DB_POOL_MAX || options.max || 10)),
    idleTimeoutMillis: Math.max(
      1000,
      Number(process.env.DB_IDLE_TIMEOUT_MS || options.idleTimeoutMillis || 10000)
    ),
    connectionTimeoutMillis: Math.max(
      1000,
      Number(process.env.DB_CONNECT_TIMEOUT_MS || options.connectionTimeoutMillis || 5000)
    ),
  });
}
