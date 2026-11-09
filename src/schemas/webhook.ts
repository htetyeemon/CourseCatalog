import { z } from "zod";
import {
  CourseIdSchema,
  EventIdSchema,
  IsoDateTimeSchema,
  LimitSchema,
  PageSchema,
  TotalSchema,
  WebhookDeliveryIdSchema,
  WebhookSubscriptionIdSchema,
  paginationQueryShape,
} from "./common.js";
import { CourseSchema } from "./course.js";
import { InstructorSchema } from "./instructor.js";
import { PrerequisiteRuleSchema } from "./prerequisite.js";

const webhookUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), {
    message: "Webhook URLs must use https://.",
  });

export const WebhookEventTypeSchema = z.enum(["course.published"]);

export const WebhookSubscriptionStatusSchema = z.enum(["active", "disabled"]);

export const WebhookSubscriptionSchema = z
  .object({
    id: WebhookSubscriptionIdSchema,
    url: webhookUrlSchema,
    events: z.array(WebhookEventTypeSchema).min(1).max(10),
    status: WebhookSubscriptionStatusSchema,
    description: z.string().max(500).optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const CreateWebhookSubscriptionRequestSchema = z
  .object({
    url: webhookUrlSchema,
    events: z.array(WebhookEventTypeSchema).min(1).max(10),
    description: z.string().max(500).optional(),
  })
  .strict();

export const WebhookSubscriptionCreatedSchema = WebhookSubscriptionSchema.extend({
  signingSecret: z.string().min(32).max(256),
});

export const WebhookSubscriptionCreatedResponseSchema = z
  .object({
    data: WebhookSubscriptionCreatedSchema,
  })
  .strict();

export const WebhookDeliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
  "exhausted",
]);

export const WebhookDeliverySchema = z
  .object({
    id: WebhookDeliveryIdSchema,
    subscriptionId: WebhookSubscriptionIdSchema,
    eventId: EventIdSchema,
    eventType: WebhookEventTypeSchema,
    status: WebhookDeliveryStatusSchema,
    attempt: z.number().int().min(0).max(6),
    maxAttempts: z.literal(6),
    responseStatus: z.number().int().min(100).max(599).optional(),
    error: z.string().max(2000).optional(),
    createdAt: IsoDateTimeSchema,
    lastAttemptAt: IsoDateTimeSchema.optional(),
    nextAttemptAt: IsoDateTimeSchema.optional(),
    deliveredAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const WebhookDeliveryListResponseSchema = z
  .object({
    data: z.array(WebhookDeliverySchema),
    page: PageSchema,
    limit: LimitSchema,
    total: TotalSchema,
  })
  .strict();

export const ListWebhookDeliveriesQuerySchema = z
  .object({
    ...paginationQueryShape,
    subscriptionId: WebhookSubscriptionIdSchema.optional(),
    eventId: EventIdSchema.optional(),
    status: WebhookDeliveryStatusSchema.optional(),
    eventType: WebhookEventTypeSchema.optional(),
  })
  .strict();

export const EnrichmentSourceSchema = z.enum(["ai", "fallback"]);

export const CourseEnrichmentSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    tags: z.array(z.string().min(1).max(64)).max(20),
    suggestedPrerequisites: z.array(CourseIdSchema).max(20),
    source: EnrichmentSourceSchema,
  })
  .strict();

export const CoursePublishedDataSchema = z
  .object({
    course: CourseSchema,
    instructors: z.array(InstructorSchema).max(20),
    prerequisites: z.array(PrerequisiteRuleSchema).max(50),
    enrichment: CourseEnrichmentSchema,
  })
  .strict();

export const CoursePublishedEventSchema = z
  .object({
    id: EventIdSchema,
    type: z.literal("course.published"),
    version: z.literal("1.0"),
    occurredAt: IsoDateTimeSchema,
    data: CoursePublishedDataSchema,
  })
  .strict();
