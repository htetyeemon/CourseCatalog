import { z } from "zod";
import {
  CourseIdSchema,
  IsoDateTimeSchema,
  StudentIdSchema,
} from "./common.js";

export const PrerequisiteRuleSchema = z
  .object({
    courseId: CourseIdSchema,
    required: z.boolean().default(true),
    minimumGrade: z.number().min(0).max(100).optional(),
  })
  .strict();

export const PutPrerequisitesRequestSchema = z
  .object({
    prerequisites: z.array(PrerequisiteRuleSchema).max(50),
  })
  .strict();

export const PrerequisiteSetSchema = z
  .object({
    courseId: CourseIdSchema,
    prerequisites: z.array(PrerequisiteRuleSchema).max(50),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const PrerequisitesResponseSchema = z
  .object({
    data: PrerequisiteSetSchema,
  })
  .strict();

export const EligibilityCheckRequestSchema = z
  .object({
    studentId: StudentIdSchema,
  })
  .strict();

export const EligibilityReasonSchema = z.enum([
  "satisfied",
  "not_completed",
  "grade_below_minimum",
  "missing_record",
]);

export const EligibilityCheckSchema = z
  .object({
    courseId: CourseIdSchema,
    required: z.boolean(),
    satisfied: z.boolean(),
    minimumGrade: z.number().min(0).max(100).optional(),
    earnedGrade: z.number().min(0).max(100).optional(),
    reason: EligibilityReasonSchema,
  })
  .strict();

export const EligibilityResultSchema = z
  .object({
    studentId: StudentIdSchema,
    courseId: CourseIdSchema,
    eligible: z.boolean(),
    evaluatedAt: IsoDateTimeSchema,
    checks: z.array(EligibilityCheckSchema).max(50),
  })
  .strict();

export const EligibilityCheckResponseSchema = z
  .object({
    data: EligibilityResultSchema,
  })
  .strict();
