import dotenv from "dotenv";
import path from "path";
import { INDEXER_MIGRATIONS_TABLE } from "./runMigrations";

dotenv.config();

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://nebgov:nebgov@localhost:5432/nebgov";

  const command = process.argv[2];
  const { runner } = await import("node-pg-migrate");

  if (command === "down") {
    const countRaw = process.argv[3];
    const count = countRaw ? Number(countRaw) : 1;
    if (!Number.isFinite(count) || count < 1) {
      console.error(
        "Usage: npm run migrate down [count]\nExample: npm run migrate down 1",
      );
      process.exit(1);
    }
    await runner({
      databaseUrl,
      dir: path.join(process.cwd(), "migrations"),
      direction: "down",
      count,
      migrationsTable: INDEXER_MIGRATIONS_TABLE,
    });
  } else {
    await runner({
      databaseUrl,
      dir: path.join(process.cwd(), "migrations"),
      direction: "up",
      migrationsTable: INDEXER_MIGRATIONS_TABLE,
    });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
