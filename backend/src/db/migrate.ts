import dotenv from "dotenv";
import path from "path";
import { BACKEND_MIGRATIONS_TABLE } from "./migrationRunner";

dotenv.config();

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

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
      migrationsTable: BACKEND_MIGRATIONS_TABLE,
    });
  } else {
    await runner({
      databaseUrl,
      dir: path.join(process.cwd(), "migrations"),
      direction: "up",
      migrationsTable: BACKEND_MIGRATIONS_TABLE,
    });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
