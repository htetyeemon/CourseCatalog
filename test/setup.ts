import { beforeEach } from "vitest";
import { env } from "cloudflare:workers";

// Workers AI is a remote-only binding, even in local dev and tests. Replace it with a
// stub that always fails so enrichment deterministically takes the fallback path and
// tests never call the real service. Tests that need AI behaviour install their own
// mock on `env.AI` (see publish.test.ts).
beforeEach(() => {
  (env as unknown as Record<string, unknown>).AI = {
    run: () => Promise.reject(new Error("Workers AI is disabled in tests.")),
  };
});
