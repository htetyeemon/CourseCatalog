import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Migrations are read on the Node side in vitest.config.ts and provided to the
// Workers runtime as the TEST_MIGRATIONS binding.
export async function applyTestMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

// reset() deletes all data from every binding, including the D1 schema, so the
// migrations are re-applied to leave a clean, usable database for the next test.
export async function resetTestState(): Promise<void> {
  await reset();
  await applyTestMigrations();
}

export { env };
