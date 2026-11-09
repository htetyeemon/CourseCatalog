import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { readD1Migrations } from "@cloudflare/vitest-plugin";

export async function applyTestMigrations(): Promise<void> {
  const migrations = await readD1Migrations("./migrations");
  await applyD1Migrations(env.DB, migrations);
}

export async function resetTestState(): Promise<void> {
  await reset();
}

export { env };
