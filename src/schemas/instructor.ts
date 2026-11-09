import { z } from "zod";
import {
  CourseIdSchema,
  InstructorIdSchema,
  IsoDateTimeSchema,
  LimitSchema,
  PageSchema,
  SortOrderSchema,
  TotalSchema,
  paginationQueryShape,
} from "./common.js";

const instructorDisplayNameSchema = z.string().min(1).max(120);
const instructorDepartmentSchema = z.string().min(1).max(120);

export const InstructorSortSchema = z.enum([
  "name",
  "department",
  "createdAt",
]);

export const InstructorSchema = z
  .object({
    id: InstructorIdSchema,
    displayName: instructorDisplayNameSchema,
    email: z.email(),
    department: instructorDepartmentSchema,
    bio: z.string().max(2000).optional(),
    courseIds: z.array(CourseIdSchema).max(50).optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const InstructorResponseSchema = z
  .object({
    data: InstructorSchema,
  })
  .strict();

export const InstructorListResponseSchema = z
  .object({
    data: z.array(InstructorSchema),
    page: PageSchema,
    limit: LimitSchema,
    total: TotalSchema,
  })
  .strict();

export const ListInstructorsQuerySchema = z
  .object({
    ...paginationQueryShape,
    q: z.string().min(1).max(200).optional(),
    department: instructorDepartmentSchema.optional(),
    sort: InstructorSortSchema.default("name"),
    order: SortOrderSchema.default("asc"),
  })
  .strict();
