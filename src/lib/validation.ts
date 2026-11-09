import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../types.js";
import { apiError } from "./errors.js";

export function validationDetails(error: z.ZodError): Record<string, unknown> {
  return {
    fields: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

export async function parseJsonBody<T>(
  c: Context<AppEnv>,
  schema: z.ZodType<T>,
): Promise<
  | { success: true; data: T }
  | { success: false; response: Response }
> {
  let value: unknown;

  try {
    value = await c.req.json();
  } catch {
    return {
      success: false,
      response: apiError(
        c,
        400,
        "invalid_request",
        "The request body must be valid JSON.",
      ),
    };
  }

  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    return {
      success: false,
      response: apiError(
        c,
        422,
        "validation_failed",
        "Request validation failed.",
        validationDetails(parsed.error),
      ),
    };
  }

  return { success: true, data: parsed.data };
}
