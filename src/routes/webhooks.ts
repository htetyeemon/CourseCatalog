import { Hono } from "hono";
import {
  createSubscription,
  listSubscriptions,
  listDeliveries,
} from "../db/webhooks.js";
import { READ_ROLES, WRITE_ROLES, requireRole } from "../lib/auth.js";
import { apiError } from "../lib/errors.js";
import { parseJsonBody } from "../lib/validation.js";
import {
  CreateWebhookSubscriptionRequestSchema,
  ListWebhookDeliveriesQuerySchema,
} from "../schemas/webhook.js";
import { paginationQueryShape } from "../schemas/common.js";
import { z } from "zod";
import type { AppEnv } from "../types.js";

export const webhooksRoute = new Hono<AppEnv>();

const ListSubscriptionsQuerySchema = z
  .object({
    ...paginationQueryShape,
  })
  .strict();

webhooksRoute.post(
  "/subscriptions",
  requireRole(...WRITE_ROLES),
  async (c) => {
    const body = await parseJsonBody(c, CreateWebhookSubscriptionRequestSchema);

    if (!body.success) {
      return body.response;
    }

    const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

    const subscription = await createSubscription(c.env.DB, {
      url: body.data.url,
      events: body.data.events,
      description: body.data.description,
      secret,
    });

    return c.json({ data: subscription }, 201);
  },
);

webhooksRoute.get(
  "/subscriptions",
  requireRole(...READ_ROLES),
  async (c) => {
    const parsed = ListSubscriptionsQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Invalid query parameters.", {
        issues: parsed.error.issues,
      });
    }

    const subscriptions = await listSubscriptions(c.env.DB);

    return c.json({
      data: subscriptions.slice(
        (parsed.data.page - 1) * parsed.data.limit,
        parsed.data.page * parsed.data.limit,
      ),
      page: parsed.data.page,
      limit: parsed.data.limit,
      total: subscriptions.length,
    });
  },
);

webhooksRoute.get(
  "/deliveries",
  requireRole(...WRITE_ROLES),
  async (c) => {
    const parsed = ListWebhookDeliveriesQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Invalid query parameters.", {
        issues: parsed.error.issues,
      });
    }

    const result = await listDeliveries(c.env.DB, {
      page: parsed.data.page,
      limit: parsed.data.limit,
      subscriptionId: parsed.data.subscriptionId,
      eventId: parsed.data.eventId,
      status: parsed.data.status,
      eventType: parsed.data.eventType,
    });

    return c.json(result);
  },
);
