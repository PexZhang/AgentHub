import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { normalizePgIdentifier } from "../db/client.js";
import { normalizeText } from "../shared/domain-utils.js";
import { JsonStore } from "./json-store.js";
import { PostgresStore } from "./postgres-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveStoreDriver(value) {
  const explicitDriver = normalizeText(value).toLowerCase();
  if (["postgres", "pg"].includes(explicitDriver)) {
    return "postgres";
  }
  return "json";
}

export function createStoreFromEnv(options = {}) {
  const env = options.env || process.env;
  const storeDriver = resolveStoreDriver(env.STORE_DRIVER);
  const snapshotConversationMessageLimit = options.snapshotConversationMessageLimit;
  const snapshotManagerMessageLimit = options.snapshotManagerMessageLimit;
  const managerProvider = options.managerProvider;
  const managerModel = options.managerModel;

  if (storeDriver === "postgres") {
    const connectionString = normalizeText(env.DATABASE_URL);
    if (!connectionString) {
      throw new Error("STORE_DRIVER=postgres 时必须提供 DATABASE_URL。");
    }

    return new PostgresStore({
      connectionString,
      schema: normalizePgIdentifier(env.STORE_PG_SCHEMA, "public"),
      tableName: normalizePgIdentifier(env.STORE_PG_STATE_TABLE, "hub_state"),
      stateKey: normalizeText(env.STORE_PG_STATE_KEY) || "primary",
      snapshotConversationMessageLimit,
      snapshotManagerMessageLimit,
      managerProvider,
      managerModel,
    });
  }

  return new JsonStore({
    filePath:
      normalizeText(env.DATA_FILE) || join(__dirname, "..", "..", "data", "state.json"),
    snapshotConversationMessageLimit,
    snapshotManagerMessageLimit,
    managerProvider,
    managerModel,
  });
}
