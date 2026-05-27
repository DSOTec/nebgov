declare module "node-pg-migrate" {
  export interface RunnerOption {
    databaseUrl?: string | Record<string, unknown>;
    dir: string | string[];
    direction: "up" | "down";
    count?: number;
    migrationsTable?: string;
    verbose?: boolean;
    [key: string]: unknown;
  }

  export function runner(options: RunnerOption): Promise<Array<unknown>>;
}
