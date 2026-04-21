import "dotenv/config";
import { promises as fs } from "fs";
import { resolve } from "path";
import { createDatabasePool, normalizePgIdentifier } from "../server/db/client.js";
import { createPostgresStateRepository } from "../server/repositories/postgres-state.js";

function normalizeText(value) {
  return String(value || "").trim();
}

function resolveInputFile() {
  const flagIndex = process.argv.findIndex((item) => item === "--file");
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return resolve(process.argv[flagIndex + 1]);
  }

  const positional = process.argv.slice(2).find((item) => !item.startsWith("-"));
  if (positional) {
    return resolve(positional);
  }

  const fromEnv = normalizeText(process.env.DATA_FILE);
  if (fromEnv) {
    return resolve(fromEnv);
  }

  throw new Error("缺少 JSON 状态文件。请提供 DATA_FILE 或 --file /path/to/state.json。");
}

async function main() {
  const inputFile = resolveInputFile();
  const raw = await fs.readFile(inputFile, "utf8");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`状态文件不是合法 JSON: ${inputFile} (${error.message})`);
  }
  if (!parsed || !Array.isArray(parsed.conversations)) {
    throw new Error(`状态文件格式不正确: ${inputFile}`);
  }

  const pool = createDatabasePool();
  try {
    const repository = createPostgresStateRepository({
      pool,
      schema: normalizePgIdentifier(process.env.STORE_PG_SCHEMA, "public"),
      tableName: normalizePgIdentifier(process.env.STORE_PG_STATE_TABLE, "hub_state"),
    });
    const storeKey = normalizeText(process.env.STORE_PG_STATE_KEY) || "primary";

    await repository.ensureTable();
    await repository.saveState(storeKey, parsed);

    console.log(`已导入 JSON 状态到 PostgreSQL: ${inputFile} -> ${repository.qualifiedTableName} (${storeKey})`);
  } finally {
    await pool.end();
  }
}

await main();
