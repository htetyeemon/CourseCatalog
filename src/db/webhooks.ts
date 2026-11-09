import { z } from "zod";
import { AppError } from "../lib/app-error.js";
import { placeholders } from "./shared.js";
import {
  WebhookDeliverySchema,
  WebhookSubscriptionSchema,
} from "../schemas/webhook.js";

type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;
type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

interface SubscriptionRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
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
}

const MAX_ATTEMPTS = 6;

export async function createSubscription(
  db: D1Database,
  input: {
    url: string;
    events: string[];
    description: string | undefined;
    secret: string;
  },
): Promise<WebhookSubscription & { signingSecret: string }> {
  const id = `whs_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();

  const existing = await db
    .prepare("SELECT id FROM webhook_subscriptions WHERE url = ? AND active = 1")
    .bind(input.url)
    .first<{ id: string }>();

  if (existing !== null) {
    throw new AppError(
      409,
      "conflict",
      "An active subscription already exists for this URL.",
      { url: input.url },
    );
  }

  await db
    .prepare(
      `INSERT INTO webhook_subscriptions
         (id, url, secret, events, description, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      input.url,
      input.secret,
      JSON.stringify(input.events),
      input.description ?? null,
      now,
      now,
    );

  return {
    id,
    url: input.url,
    events: input.events as WebhookSubscription["events"],
    status: "active",
    description: input.description,
    createdAt: now,
    updatedAt: now,
    signingSecret: input.secret,
  };
}

export async function listSubscriptions(
  db: D1Database,
): Promise<WebhookSubscription[]> {
  const rows = await db
    .prepare(
      `SELECT id, url, secret, events, description, active, created_at, updated_at
       FROM webhook_subscriptions
       ORDER BY created_at DESC`,
    )
    .all<SubscriptionRow>();

  return rows.results.map((row) => ({
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as WebhookSubscription["events"],
    status: row.active === 1 ? ("active" as const) : ("disabled" as const),
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getSubscription(
  db: D1Database,
  id: string,
): Promise<(WebhookSubscription & { secret: string }) | null> {
  const row = await db
    .prepare(
      `SELECT id, url, secret, events, description, active, created_at, updated_at
       FROM webhook_subscriptions
       WHERE id = ?`,
    )
    .bind(id)
    .first<SubscriptionRow>();

  if (row === null) {
    return null;
  }

  return {
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as WebhookSubscription["events"],
    status: row.active === 1 ? ("active" as const) : ("disabled" as const),
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    secret: row.secret,
  };
}

export async function getActiveSubscriptions(
  db: D1Database,
): Promise<{
  id: string;
  url: string;
  secret: string;
  events: string[];
}[]> {
  const rows = await db
    .prepare(
      `SELECT id, url, secret, events
       FROM webhook_subscriptions
       WHERE active = 1`,
    )
    .all<{ id: string; url: string; secret: string; events: string }>();

  return rows.results.map((row) => ({
    id: row.id,
    url: row.url,
    secret: row.secret,
    events: JSON.parse(row.events),
  }));
}

export async function disableSubscription(
  db: D1Database,
  id: string,
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE webhook_subscriptions
       SET active = 0, updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, id);
}

export async function createDelivery(
  db: D1Database,
  input: {
    subscriptionId: string;
    eventId: string;
    eventType: string;
  },
): Promise<WebhookDelivery> {
  const id = `whd_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();

  const existing = await db
    .prepare(
      `SELECT id FROM webhook_deliveries
       WHERE subscription_id = ? AND event_id = ?`,
    )
    .bind(input.subscriptionId, input.eventId)
    .first<{ id: string }>();

  if (existing !== null) {
    throw new AppError(
      409,
      "conflict",
      "A delivery for this subscription and event already exists.",
      { subscriptionId: input.subscriptionId, eventId: input.eventId },
    );
  }

  await db
    .prepare(
      `INSERT INTO webhook_deliveries
         (id, subscription_id, event_id, event_type, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 6, ?, ?, ?)`,
    )
    .bind(id, input.subscriptionId, input.eventId, input.eventType, now, now, now);

  return {
    id,
    subscriptionId: input.subscriptionId,
    eventId: input.eventId,
    eventType: input.eventType as WebhookDelivery["eventType"],
    status: "pending",
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS as 6,
    createdAt: now,
  };
}

export async function getDueDeliveries(
  db: D1Database,
  limit = 100,
): Promise<WebhookDelivery[]> {
  const now = new Date().toISOString();

  const rows = await db
    .prepare(
      `SELECT id, subscription_id, event_id, event_type, status, attempts, max_attempts,
              response_status, last_error, next_attempt_at, last_attempt_at,
              delivered_at, created_at, updated_at
       FROM webhook_deliveries
       WHERE (status = 'pending' OR (status = 'failed' AND next_attempt_at <= ?))
         AND attempts < max_attempts
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<DeliveryRow>();

  return rows.results.map(toDelivery);
}

export async function updateDelivery(
  db: D1Database,
  id: string,
  patch: {
    status?: string;
    attempts?: number;
    responseStatus?: number | null;
    lastError?: string | null;
    nextAttemptAt?: string | null;
    lastAttemptAt?: string | null;
    deliveredAt?: string | null;
  },
): Promise<void> {
  const assignments: string[] = ["updated_at = ?"];
  const bindings: unknown[] = [new Date().toISOString()];

  if (patch.status !== undefined) {
    assignments.push("status = ?");
    bindings.push(patch.status);
  }

  if (patch.attempts !== undefined) {
    assignments.push("attempts = ?");
    bindings.push(patch.attempts);
  }

  if (patch.responseStatus !== undefined) {
    assignments.push("response_status = ?");
    bindings.push(patch.responseStatus);
  }

  if (patch.lastError !== undefined) {
    assignments.push("last_error = ?");
    bindings.push(patch.lastError);
  }

  if (patch.nextAttemptAt !== undefined) {
    assignments.push("next_attempt_at = ?");
    bindings.push(patch.nextAttemptAt);
  }

  if (patch.lastAttemptAt !== undefined) {
    assignments.push("last_attempt_at = ?");
    bindings.push(patch.lastAttemptAt);
  }

  if (patch.deliveredAt !== undefined) {
    assignments.push("delivered_at = ?");
    bindings.push(patch.deliveredAt);
  }

  bindings.push(id);

  await db
    .prepare(
      `UPDATE webhook_deliveries
       SET ${assignments.join(", ")}
       WHERE id = ?`,
    )
    .bind(...bindings);
}

export async function listDeliveries(
  db: D1Database,
  filters: {
    page: number;
    limit: number;
    subscriptionId?: string;
    eventId?: string;
    status?: string;
    eventType?: string;
  },
): Promise<{
  data: WebhookDelivery[];
  page: number;
  limit: number;
  total: number;
}> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (filters.subscriptionId !== undefined) {
    conditions.push("subscription_id = ?");
    bindings.push(filters.subscriptionId);
  }

  if (filters.eventId !== undefined) {
    conditions.push("event_id = ?");
    bindings.push(filters.eventId);
  }

  if (filters.status !== undefined) {
    conditions.push("status = ?");
    bindings.push(filters.status);
  }

  if (filters.eventType !== undefined) {
    conditions.push("event_type = ?");
    bindings.push(filters.eventType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM webhook_deliveries ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);

  const offset = (filters.page - 1) * filters.limit;

  const rows = await db
    .prepare(
      `SELECT id, subscription_id, event_id, event_type, status, attempts, max_attempts,
              response_status, last_error, next_attempt_at, last_attempt_at,
              delivered_at, created_at, updated_at
       FROM webhook_deliveries
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, filters.limit, offset)
    .all<DeliveryRow>();

  return {
    data: rows.results.map(toDelivery),
    page: filters.page,
    limit: filters.limit,
    total,
  };
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    eventType: row.event_type as WebhookDelivery["eventType"],
    status: row.status as WebhookDelivery["status"],
    attempt: row.attempts,
    maxAttempts: row.max_attempts as 6,
    responseStatus: row.response_status ?? undefined,
    error: row.last_error ?? undefined,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
  };
}
