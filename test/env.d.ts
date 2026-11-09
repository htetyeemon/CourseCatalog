// Test-only bindings injected by vitest.config.ts (miniflare.bindings).
import type { D1Migration } from "cloudflare:test";

declare global {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
  }

  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
