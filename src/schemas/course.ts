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

const courseCodeSchema = z
  .string()
  .regex(/^[A-Z]{2,8}-[0-9]{3,4}$/, "Must match a course code such as CS-101.");

const courseTitleSchema = z.string().min(1).max(200);
const courseDescriptionSchema = z.string().min(1).max(5000);
const courseCreditsSchema = z.number().int().min(0).max(30);
const courseDepartmentSchema = z.string().min(1).max(120);
const courseInstructorIdsSchema = z.array(InstructorIdSchema).max(20);

export const CourseStatusSchema = z.enum(["draft", "published", "archived"]);

export const CourseLevelSchema = z.enum([
  "introductory",
  "intermediate",
  "advanced",
]);

export const CourseSortSchema = z.enum([
  "code",
  "title",
  "createdAt",
  "updatedAt",
]);

export const CourseSchema = z
  .object({
    id: CourseIdSchema,
    code: courseCodeSchema,
    title: courseTitleSchema,
    description: courseDescriptionSchema,
    status: CourseStatusSchema,
    credits: courseCreditsSchema,
    level: CourseLevelSchema,
    department: courseDepartmentSchema,
    instructorIds: courseInstructorIdsSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    publishedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const CourseResponseSchema = z
  .object({
    data: CourseSchema,
  })
  .strict();

export const CourseListResponseSchema = z
  .object({
    data: z.array(CourseSchema),
    page: PageSchema,
    limit: LimitSchema,
    total: TotalSchema,
  })
  .strict();

export const CreateCourseRequestSchema = z
  .object({
    code: courseCodeSchema,
    title: courseTitleSchema,
    description: courseDescriptionSchema,
    credits: courseCreditsSchema,
    level: CourseLevelSchema,
    department: courseDepartmentSchema,
    instructorIds: courseInstructorIdsSchema.optional(),
  })
  .strict();

export const UpdateCourseRequestSchema = z
  .object({
    code: courseCodeSchema.optional(),
    title: courseTitleSchema.optional(),
    description: courseDescriptionSchema.optional(),
    credits: courseCreditsSchema.optional(),
    level: CourseLevelSchema.optional(),
    department: courseDepartmentSchema.optional(),
    instructorIds: courseInstructorIdsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

export const ListCoursesQuerySchema = z
  .object({
    ...paginationQueryShape,
    q: z.string().min(1).max(200).optional(),
    status: CourseStatusSchema.optional(),
    department: courseDepartmentSchema.optional(),
    level: CourseLevelSchema.optional(),
    instructorId: InstructorIdSchema.optional(),
    sort: CourseSortSchema.default("title"),
    order: SortOrderSchema.default("asc"),
  })
  .strict();
