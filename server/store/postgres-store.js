import { createDatabasePool, normalizePgIdentifier } from "../db/client.js";
import { createPostgresStateRepository } from "../repositories/postgres-state.js";
import { normalizeText } from "../shared/domain-utils.js";
import { buildDefaultStoreState, normalizePersistedStoreState } from "./state-model.js";
import { JsonStore } from "./json-store.js";

export class PostgresStore extends JsonStore {
  constructor(options = {}) {
    super({
      filePath: `${options.schema || "public"}.${options.tableName || "hub_state"}:${options.stateKey || "primary"}`,
      snapshotConversationMessageLimit: options.snapshotConversationMessageLimit,
      snapshotManagerMessageLimit: options.snapshotManagerMessageLimit,
      managerProvider: options.managerProvider,
      managerModel: options.managerModel,
    });
    this.connectionString = normalizeText(options.connectionString);
    this.schema = normalizePgIdentifier(options.schema, "public");
    this.tableName = normalizePgIdentifier(options.tableName, "hub_state");
    this.stateKey = normalizeText(options.stateKey) || "primary";
    this.pool = createDatabasePool({ connectionString: this.connectionString });
    this.repository = createPostgresStateRepository({
      pool: this.pool,
      schema: this.schema,
      tableName: this.tableName,
    });
  }

  async init() {
    await this.repository.ensureTable();
    const persisted = await this.repository.loadState(this.stateKey);

    if (persisted?.state) {
      const nextState = normalizePersistedStoreState(persisted.state);
      if (nextState) {
        this.state = nextState;
        return;
      }
    }

    this.state = buildDefaultStoreState();
    await this.persist();
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(() =>
      this.repository.saveState(this.stateKey, this.state)
    );
    return this.writeQueue;
  }

  async close() {
    await this.writeQueue;
    await this.pool.end();
  }
}
