import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import handler from "../src/index.js";
import { applyTestMigrations, resetTestState, env } from "./helpers/db.js";

const SUBSCRIPTION_ID = "whs_sched00000000000000001";
const DELIVERY_ID = "whd_sched00000000000000001";
const EVENT_ID = "evt_sched00000000000000001";

describe("Course Catalog — scheduled handler (Cron Trigger)", () => {
  beforeAll(async () => {
    await applyTestMigrations();
  });

  afterEach(async () => {
    await resetTestState();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exports a scheduled handler", () => {
    expect(typeof handler.scheduled).toBe("function");
  });

  it("retries a due failed delivery and marks it delivered on 2xx", async () => {
    const now = new Date().toISOString();
    const body = JSON.stringify({ id: EVENT_ID, type: "course.published", version: "1.0" });

    await env.DB.prepare(
      `INSERT INTO webhook_subscriptions
         (id, url, secret, events, description, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    )
      .bind(
        SUBSCRIPTION_ID,
        "https://example.com/webhook",
        "whsec_test_secret_0123456789abcdef0123456789abcdef",
        JSON.stringify(["course.published"]),
        now,
        now,
      )
      .run();

    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
         (id, subscription_id, event_id, event_type, status, attempts, max_attempts,
          next_attempt_at, request_body, created_at, updated_at)
       VALUES (?, ?, ?, 'course.published', 'failed', 1, 6, ?, ?, ?, ?)`,
    )
      .bind(DELIVERY_ID, SUBSCRIPTION_ID, EVENT_ID, new Date(0).toISOString(), body, now, now)
      .run();

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createExecutionContext();
    await handler.scheduled(
      createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/webhook");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Catalog-Event-Id"]).toBe(EVENT_ID);
    expect(headers["X-Catalog-Signature"]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    const row = await env.DB.prepare(
      "SELECT status, attempts, response_status FROM webhook_deliveries WHERE id = ?",
    )
      .bind(DELIVERY_ID)
      .first<{ status: string; attempts: number; response_status: number | null }>();
    expect(row).toEqual({ status: "delivered", attempts: 2, response_status: 200 });
  });
});
