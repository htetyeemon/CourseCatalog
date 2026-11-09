import { createHmac } from "node:crypto";
import {
  getActiveSubscriptions,
  updateDelivery,
  disableSubscription,
} from "../db/webhooks.js";

const EVENT_TYPE = "course.published";
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function nowIso(): string {
  return new Date().toISOString();
}

function secondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function buildSignature(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`)
    .digest("hex" as any) as string;
}

export function buildSignatureHeader(
  secret: string,
  body: string,
): { timestamp: number; header: string } {
  const timestamp = nowSeconds();
  const signature = buildSignature(secret, timestamp, body);

  return { timestamp, header: `t=${timestamp},v1=${signature}` };
}

function isRetryableStatus(status: number): boolean {
  if (status >= 500) {
    return true;
  }

  return status === 408 || status === 429;
}

function computeBackoffSeconds(attemptsMade: number): number {
  const nextAttempt = attemptsMade + 1;

  if (nextAttempt < 2) {
    return 0;
  }

  return Math.min(30 * Math.pow(4, nextAttempt - 2), 7200);
}

function applyJitter(seconds: number): number {
  return seconds * (0.8 + Math.random() * 0.4);
}

async function attemptDelivery(
  url: string,
  secret: string,
  eventId: string,
  body: string,
): Promise<{
  ok: boolean;
  status: number | null;
  error: string | null;
  retryable: boolean;
}> {
  const { timestamp, header } = buildSignatureHeader(secret, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "CourseCatalog-Webhooks/1.0",
        "X-Catalog-Event": EVENT_TYPE,
        "X-Catalog-Event-Id": eventId,
        "X-Catalog-Delivery": `whd_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`,
        "X-Catalog-Signature": header,
      },
      body,
      signal: controller.signal,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      error: null,
      retryable: isRetryableStatus(response.status),
    };
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "AbortError";

    return {
      ok: false,
      status: null,
      error: isTimeout
        ? "delivery timeout"
        : error instanceof Error
          ? error.message
          : "delivery failed",
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface DeliveryOutcome {
  deliveryId: string;
  subscriptionId: string;
  eventId: string;
  status: "delivered" | "failed" | "exhausted";
  nextAttemptAt: string | null;
}

export async function attemptDeliveryForPublish(
  db: D1Database,
  deliveryId: string,
  subscription: { id: string; url: string; secret: string },
  eventId: string,
  body: string,
): Promise<DeliveryOutcome> {
  const result = await attemptDelivery(subscription.url, subscription.secret, eventId, body);
  const now = nowIso();

  if (result.ok) {
    await updateDelivery(db, deliveryId, {
      status: "delivered",
      attempts: 1,
      responseStatus: result.status ?? undefined,
      deliveredAt: now,
      lastAttemptAt: now,
    });
    return { deliveryId, subscriptionId: subscription.id, eventId, status: "delivered", nextAttemptAt: null };
  }

  if (result.status === 410) {
    await disableSubscription(db, subscription.id);
    await updateDelivery(db, deliveryId, {
      status: "exhausted",
      attempts: 1,
      responseStatus: result.status,
      lastError: result.error ?? "subscription gone",
      lastAttemptAt: now,
    });
    return { deliveryId, subscriptionId: subscription.id, eventId, status: "exhausted", nextAttemptAt: null };
  }

  if (!result.retryable) {
    await updateDelivery(db, deliveryId, {
      status: "exhausted",
      attempts: 1,
      responseStatus: result.status,
      lastError: result.error ?? `non-retryable HTTP ${result.status}`,
      lastAttemptAt: now,
    });
    return { deliveryId, subscriptionId: subscription.id, eventId, status: "exhausted", nextAttemptAt: null };
  }

  const delay = applyJitter(computeBackoffSeconds(1));
  const nextAttemptAt = secondsFromNow(delay);
  await updateDelivery(db, deliveryId, {
    status: "failed",
    attempts: 1,
    responseStatus: result.status ?? undefined,
    lastError: result.error ?? "delivery failed",
    lastAttemptAt: now,
    nextAttemptAt,
  });
  return { deliveryId, subscriptionId: subscription.id, eventId, status: "failed", nextAttemptAt };
}

export async function processDueDeliveries(
  env: { DB: D1Database },
): Promise<{
  processed: number;
  delivered: number;
  failed: number;
  exhausted: number;
}> {
  const { DB } = env;
  const now = nowIso();
  const dueRows = await DB
    .prepare(
      `SELECT id, subscription_id, event_id, event_type, status, attempts, max_attempts,
              response_status, last_error, next_attempt_at, last_attempt_at,
              delivered_at, created_at, updated_at, request_body
       FROM webhook_deliveries
       WHERE (status = 'pending' OR (status = 'failed' AND next_attempt_at <= ?))
         AND attempts < max_attempts
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT 100`,
    )
    .bind(now)
    .all<{
      id: string;
      subscription_id: string;
      event_id: string;
      event_type: string;
      status: string;
      attempts: number;
      max_attempts: number;
      response_status: number | null;
      last_error: string | null;
      next_attempt_at: string | null;
      last_attempt_at: string | null;
      delivered_at: string | null;
      created_at: string;
      updated_at: string;
      request_body: string | null;
    }>();

  const subscriptions = await getActiveSubscriptions(DB);
  const subscriptionById = new Map(subscriptions.map((s) => [s.id, s]));

  let processed = 0;
  let delivered = 0;
  let failed = 0;
  let exhausted = 0;

  for (const row of dueRows.results) {
    processed += 1;
    const deliveryId = row.id;
    const subscription = subscriptionById.get(row.subscription_id);
    const body = row.request_body;

    if (subscription === undefined || body === null) {
      await updateDelivery(DB, deliveryId, {
        status: "exhausted",
        lastError: "subscription inactive or body unavailable",
      });
      exhausted += 1;
      continue;
    }

    if (row.attempts >= MAX_ATTEMPTS - 1) {
      await updateDelivery(DB, deliveryId, {
        status: "exhausted",
        attempts: row.attempts + 1,
        lastError: "max attempts reached",
      });
      exhausted += 1;
      continue;
    }

    const result = await attemptDelivery(subscription.url, subscription.secret, row.event_id, body);
    const attemptNow = nowIso();

    if (result.ok) {
      await updateDelivery(DB, deliveryId, {
        status: "delivered",
        attempts: row.attempts + 1,
        responseStatus: result.status ?? undefined,
        deliveredAt: attemptNow,
        lastAttemptAt: attemptNow,
      });
      delivered += 1;
      continue;
    }

    if (result.status === 410) {
      await disableSubscription(DB, subscription.id);
      await updateDelivery(DB, deliveryId, {
        status: "exhausted",
        attempts: row.attempts + 1,
        responseStatus: result.status,
        lastError: result.error ?? "subscription gone",
        lastAttemptAt: attemptNow,
      });
      exhausted += 1;
      continue;
    }

    if (!result.retryable) {
      await updateDelivery(DB, deliveryId, {
        status: "exhausted",
        attempts: row.attempts + 1,
        responseStatus: result.status,
        lastError: result.error ?? `non-retryable HTTP ${result.status}`,
        lastAttemptAt: attemptNow,
      });
      exhausted += 1;
      continue;
    }

    const delay = applyJitter(computeBackoffSeconds(row.attempts + 1));
    await updateDelivery(DB, deliveryId, {
      status: "failed",
      attempts: row.attempts + 1,
      responseStatus: result.status ?? undefined,
      lastError: result.error ?? "delivery failed",
      lastAttemptAt: attemptNow,
      nextAttemptAt: secondsFromNow(delay),
    });
    failed += 1;
  }

  return { processed, delivered, failed, exhausted };
}
