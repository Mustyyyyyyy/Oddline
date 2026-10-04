import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import type { Database } from "./types.js";

const { Pool } = pg;
const migratedDatabases = new WeakSet<object>();

export function createDatabase(connectionString = process.env.DATABASE_URL): pg.Pool {
  const connection = connectionString
    ? { connectionString }
    : {
        host: process.env.PGHOST ?? "127.0.0.1",
        port: Number(process.env.PGPORT ?? 5432),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
      };
  if (!connectionString && (!connection.database || !connection.user || !connection.password)) {
    throw new Error("Configure DATABASE_URL or PGDATABASE, PGUSER, and PGPASSWORD.");
  }
  return new Pool({
    ...connection,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 3),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
}

export async function migrate(database: Database): Promise<void> {
  if (migratedDatabases.has(database)) return;
  const migrationDirectory = resolve(process.env.MIGRATIONS_DIR ?? "server/migrations");
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  const client = await database.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename TEXT PRIMARY KEY
       )`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migration_lock (
         id INTEGER PRIMARY KEY
       )`,
    );
    await client.query(
      "INSERT INTO schema_migration_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
    );
    await client.query("BEGIN");
    await client.query("SELECT id FROM schema_migration_lock WHERE id = 1 FOR UPDATE");
    const { rows } = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map(({ filename }) => filename));
    for (const file of migrations) {
      if (applied.has(file)) continue;
      const migration = await readFile(resolve(migrationDirectory, file), "utf8");
      await client.query(migration);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    }
    await client.query("COMMIT");
    migratedDatabases.add(database);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
