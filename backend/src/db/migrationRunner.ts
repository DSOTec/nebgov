import path from "path";

export const BACKEND_MIGRATIONS_TABLE = "pgmigrations_nebgov_backend";

export async function runBackendMigrations(): Promise<void> {
  const { runner } = await import("node-pg-migrate");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }
  await runner({
    databaseUrl,
    dir: path.join(process.cwd(), "migrations"),
    direction: "up",
    migrationsTable: BACKEND_MIGRATIONS_TABLE,
    verbose: process.env.LOG_MIGRATIONS === "1",
  });
}
