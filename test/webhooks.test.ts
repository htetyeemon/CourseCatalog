import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import app from "../src/index.js";
import { buildSignatureHeader, processDueDeliveries } from "../src/lib/delivery.js";
import { applyTestMigrations, resetTestState, env } from "./helpers/db.js";
import { mintToken, authHeaders, ROLES } from "./helpers/tokens.js";

function request(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request("http://localhost" + input, init), env),
  );
}

async function insertSubscription(
  overrides: {
    id?: string;
    url?: string;
    secret?: string;
    events?: string[];
    description?: string | null;
    active?: boolean;
  } = {},
): Promise<string> {
  const id = overrides.id ?? `whs_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO webhook_subscriptions
       (id, url, secret, events, description, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    overrides.url ?? "https://example.com/webhook",
    overrides.secret ?? "whsec_test_secret_0123456789abcdef0123456789abcdef",
    JSON.stringify(overrides.events ?? ["course.published"]),
    overrides.description ?? null,
    overrides.active ?? true ? 1 : 0,
    now,
    now,
  )
  .run();
  return id;
}

function jsonBody(value: unknown): BodyInit {
  return JSON.stringify(value);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function verifySignature(
  rawBody: string,
  signatureHeader: string,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return false;
  const timestamp = Number(tPart.slice(2));
  const providedHex = v1Part.slice(3);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > 300) return false;
  if (!/^[a-f0-9]{64}$/.test(providedHex)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(providedHex),
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
}

async function insertCourseHelper(
  overrides: { id?: string; code?: string; status?: string } = {},
): Promise<string> {
  const id = overrides.id ?? `crs_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO courses (id, code, title, description, department, level, credits, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    overrides.code ?? `CS-WH${Math.floor(Math.random() * 9000) + 1000}`,
    "Webhook Course",
    "A course for webhook tests.",
    "Computer Science",
    "introductory",
    3,
    overrides.status ?? "published",
    now,
    now,
  )
  .run();
  const insId = `ins_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  await env.DB.prepare(
    `INSERT INTO instructors (id, display_name, email, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(insId, "Dr. Wh", `${insId}@example.edu`, "Computer Science", now, now)
  .run();
  await env.DB.prepare(
    `INSERT INTO course_instructors (course_id, instructor_id, position) VALUES (?, ?, 0)`,
  ).bind(id, insId)
  .run();
  return id;
}

describe("Course Catalog — webhooks", () => {
  beforeAll(async () => {
    await applyTestMigrations();
  });

  afterEach(async () => {
    await resetTestState();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // --- Case 10: Webhook signature verification ---
  describe("signature scheme (t=<unix>,v1=<hex>)", () => {
    const secret = "whsec_test_secret_0123456789abcdef0123456789abcdef";
    const body = JSON.stringify({ id: "evt_01", type: "course.published", version: "1.0" });

    it("verifies a freshly generated signature", async () => {
      const { header } = buildSignatureHeader(secret, body);
      const ok = await verifySignature(body, header, secret);
      expect(ok).toBe(true);
    });

    it("rejects a tampered body", async () => {
      const { header } = buildSignatureHeader(secret, body);
      const ok = await verifySignature(body + "tampered", header, secret);
      expect(ok).toBe(false);
    });

    it("rejects a stale timestamp (> 5 minutes)", async () => {
      const old = Math.floor(Date.now() / 1000) - 400;
      const sig = createHmac("sha256", secret)
        .update(`${old}.${body}`)
        .digest("hex" as any);
      const ok = await verifySignature(body, `t=${old},v1=${sig}`, secret);
      expect(ok).toBe(false);
    });

    it("rejects a malformed signature header", async () => {
      const ok = await verifySignature(body, "not-a-signature", secret);
      expect(ok).toBe(false);
    });
  });

  // --- Case 11: Delivery failure retries with backoff and stops after max attempts ---
  describe("delivery retry", () => {
    let courseId: string;
    let subId: string;

    beforeEach(async () => {
      courseId = await insertCourseHelper({ status: "draft" });
      subId = await insertSubscription({ url: "https://example.com/webhook" });
    });

    it("retries failed deliveries and exhausts after max attempts", async () => {
      // Stub global fetch to always fail (500).
      const failingFetch = vi.fn().mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );
      vi.stubGlobal("fetch", failingFetch as unknown);

      // Publish: attempt 1 happens immediately, fails, rescheduled.
      const publishRes = await request(`/v1/courses/${courseId}/publish`, {
        method: "POST",
        headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN) },
      });
      expect(publishRes.status).toBe(200);

      const rows = await env.DB.prepare(
        `SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE subscription_id = ?`,
      ).bind(subId).all<{ status: string; attempts: number; next_attempt_at: string | null }>();
      expect(rows.results.length).toBe(1);
      const d = rows.results[0];
      expect(d.status).toBe("failed");
      expect(d.attempts).toBe(1);
      expect(d.next_attempt_at).not.toBeNull();

      // Run retries until exhausted, forcing each scheduled retry to be due immediately
      // (the real schedule backs off from 30 seconds up to 2 hours).
      for (let i = 0; i < 10; i += 1) {
        await env.DB.prepare(
          `UPDATE webhook_deliveries SET next_attempt_at = ? WHERE subscription_id = ? AND status = 'failed'`,
        )
          .bind(new Date(0).toISOString(), subId)
          .run();
        await processDueDeliveries({ DB: env.DB } as unknown as { DB: typeof env.DB });
        const cur = await env.DB.prepare(
          `SELECT status, attempts FROM webhook_deliveries WHERE subscription_id = ?`,
        ).bind(subId).first<{ status: string; attempts: number }>();
        if (cur?.status === "exhausted") break;
      }

      const final = await env.DB.prepare(
        `SELECT status, attempts FROM webhook_deliveries WHERE subscription_id = ?`,
      ).bind(subId).first<{ status: string; attempts: number }>();
      expect(final?.status).toBe("exhausted");
      expect(final?.attempts).toBe(6);
    });
  });
});
