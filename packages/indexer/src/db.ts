import { Pool } from "pg";
import dotenv from "dotenv";
import { runIndexerMigrations } from "./runMigrations";

dotenv.config();

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://nebgov:nebgov@localhost:5432/nebgov",
});

export async function initDb(): Promise<void> {
  await runIndexerMigrations();
}
