import { describe, expect, it } from "vitest";
import app from "../src/index.js";

interface HealthBody {
  status: string;
  version: string;
  checks: {
    database: string;
    ai: string;
  };
}

interface ErrorBody {
  error: {
    code: string;
    requestId: string;
  };
}

function makeEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    DB: {
      prepare: () => ({
        first: async () => ({ ok: 1 }),
      }),
    },
    AI: {},
    ASSETS: {
      fetch: async () => new Response("asset body", { status: 200 }),
    },
    APP_VERSION: "0.1.0",
    ENVIRONMENT: "development",
    ...overrides,
  } as unknown as Env;
}

describe("worker", () => {
  it("reports healthy dependencies", async () => {
    const response = await app.request("/v1/health", undefined, makeEnv());
    const body = (await response.json()) as HealthBody;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      version: "0.1.0",
      checks: { database: "ok", ai: "ok" },
    });
  });

  it("returns a service_unavailable envelope when the database fails", async () => {
    const env = makeEnv({
      DB: {
        prepare: () => ({
          first: async () => {
            throw new Error("database unavailable");
          },
        }),
      },
    });

    const response = await app.request("/v1/health", undefined, env);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.requestId).toMatch(/^req_[A-Za-z0-9]{8,32}$/);
  });

  it("returns a not_found envelope for unknown API routes", async () => {
    const response = await app.request("/v1/unknown", undefined, makeEnv());
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toMatch(/^req_[A-Za-z0-9]{8,32}$/);
  });

  it("serves static assets for non-API routes", async () => {
    const response = await app.request("/", undefined, makeEnv());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset body");
  });
});
