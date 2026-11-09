import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  // Migrations are read on the Node side and handed to the Workers runtime as a
  // binding. Importing the plugin from inside a test would pull Miniflare into
  // workerd, which fails to load (notably on Windows).
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Hermetic default so CI and fresh clones do not need a .dev.vars file.
            JWT_SECRET:
              process.env.JWT_SECRET ??
              "vitest-only-secret-never-used-for-deployments-0000000000",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      reporters: ["verbose"],
      isolate: true,
      pool: "workers",
    },
  };
});
