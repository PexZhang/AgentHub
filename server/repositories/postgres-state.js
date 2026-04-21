import { normalizePgIdentifier, quotePgIdentifier } from "../db/client.js";

function normalizeText(value) {
  return String(value || "").trim();
}

export function createPostgresStateRepository(options = {}) {
  const pool = options.pool;
  if (!pool) {
    throw new Error("createPostgresStateRepository 需要传入 pool。");
  }

  const schema = normalizePgIdentifier(options.schema, "public");
  const tableName = normalizePgIdentifier(options.tableName, "hub_state");

  const qualifiedTableName = `${quotePgIdentifier(schema)}.${quotePgIdentifier(tableName)}`;

  return {
    schema,
    tableName,
    qualifiedTableName,

    async ensureTable() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schema)}`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
          store_key TEXT PRIMARY KEY,
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    },

    async loadState(storeKey = "primary") {
      const normalizedKey = normalizeText(storeKey) || "primary";
      const result = await pool.query(
        `SELECT state, updated_at FROM ${qualifiedTableName} WHERE store_key = $1 LIMIT 1`,
        [normalizedKey]
      );
      if (result.rowCount === 0) {
        return null;
      }

      return {
        state: result.rows[0]?.state || null,
        updatedAt: result.rows[0]?.updated_at || null,
      };
    },

    async saveState(storeKey = "primary", state) {
      const normalizedKey = normalizeText(storeKey) || "primary";
      const serializedState = typeof state === "string" ? state : JSON.stringify(state);
      await pool.query(
        `
          INSERT INTO ${qualifiedTableName} (store_key, state, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (store_key)
          DO UPDATE SET
            state = EXCLUDED.state,
            updated_at = NOW()
        `,
        [normalizedKey, serializedState]
      );
    },
  };
}
