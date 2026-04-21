import "dotenv/config";
import { promises as fs } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  createDatabasePool,
  normalizePgIdentifier,
  quotePgIdentifier,
} from "../server/db/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schemaName = normalizePgIdentifier(process.env.STORE_PG_SCHEMA, "public");
const stateTableName = normalizePgIdentifier(process.env.STORE_PG_STATE_TABLE, "hub_state");
const migrationTableName = normalizePgIdentifier(
  process.env.STORE_PG_MIGRATION_TABLE,
  "agenthub_migrations"
);

const pool = createDatabasePool();

function renderTemplate(sql) {
  return sql
    .replaceAll("{{schema}}", quotePgIdentifier(schemaName))
    .replaceAll("{{state_table}}", quotePgIdentifier(stateTableName))
    .replaceAll("{{migration_table}}", quotePgIdentifier(migrationTableName));
}

async function ensureMigrationTable() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schemaName)}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${quotePgIdentifier(schemaName)}.${quotePgIdentifier(
      migrationTableName
    )} (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function listAppliedMigrations() {
  const result = await pool.query(
    `SELECT name FROM ${quotePgIdentifier(schemaName)}.${quotePgIdentifier(migrationTableName)}`
  );
  return new Set(result.rows.map((row) => row.name));
}

async function applyMigration(name, sql) {
  const renderedSql = renderTemplate(sql);
  await pool.query("BEGIN");
  try {
    await pool.query(renderedSql);
    await pool.query(
      `INSERT INTO ${quotePgIdentifier(schemaName)}.${quotePgIdentifier(
        migrationTableName
      )} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name]
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const migrationsDir = join(__dirname, "..", "server", "db", "migrations");
  const entries = (await fs.readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  if (entries.length === 0) {
    console.log("没有找到可执行的迁移文件。");
    return;
  }

  await ensureMigrationTable();
  const applied = await listAppliedMigrations();

  for (const entry of entries) {
    if (applied.has(entry)) {
      console.log(`跳过已执行迁移: ${entry}`);
      continue;
    }

    const sql = await fs.readFile(join(migrationsDir, entry), "utf8");
    await applyMigration(entry, sql);
    console.log(`已执行迁移: ${entry}`);
  }
}

try {
  await main();
} finally {
  await pool.end();
}
