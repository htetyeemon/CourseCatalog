import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

export const HealthStatusSchema = z.enum(["ok", "degraded"]);

export const HealthChecksSchema = z
  .object({
    database: HealthStatusSchema,
    ai: HealthStatusSchema,
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    status: HealthStatusSchema,
    version: z.string().min(1),
    timestamp: IsoDateTimeSchema,
    checks: HealthChecksSchema,
  })
  .strict();
