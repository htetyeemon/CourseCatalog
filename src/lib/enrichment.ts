import { z } from "zod";
import { CourseIdSchema } from "../schemas/common.js";

const EnrichmentAiOutputSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    tags: z.array(z.string().min(1).max(64)).max(20),
    suggestedPrerequisites: z.array(CourseIdSchema).max(20),
  })
  .strict();

export interface EnrichmentResult {
  summary: string;
  tags: string[];
  suggestedPrerequisites: string[];
  source: "ai" | "fallback";
}

export interface EnrichmentProvider {
  enrich(course: {
    description: string;
    department: string;
    code: string;
    title: string;
  }): Promise<EnrichmentResult>;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "such",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "will",
  "with",
]);

function firstSentence(description: string): string {
  const match = description.match(/^[^.!?]*[.!?]?/);
  const sentence = (match?.[0] ?? description).trim();

  return sentence.slice(0, 2000);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function topKeywords(description: string, department: string): string[] {
  const counts = new Map<string, number>();

  for (const token of tokenize(description)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([token]) => token);

  const tags = new Set<string>();
  tags.add(department);

  for (const token of ranked) {
    if (tags.size >= 20) {
      break;
    }
    tags.add(token);
  }

  return [...tags].map((tag) => tag.slice(0, 64));
}

export class DeterministicEnrichmentProvider implements EnrichmentProvider {
  enrich(course: {
    description: string;
    department: string;
    code: string;
    title: string;
  }): Promise<EnrichmentResult> {
    return Promise.resolve({
      summary: firstSentence(course.description),
      tags: topKeywords(course.description, course.department),
      suggestedPrerequisites: [],
      source: "fallback",
    });
  }
}

type AiRun = (
  model: string,
  input: { prompt: string },
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export class AiEnrichmentProvider implements EnrichmentProvider {
  private readonly model = "@cf/meta/llama-3.1-8b-instruct";

  constructor(
    private readonly aiRun: AiRun | null,
    private readonly validCourseIds: Set<string>,
  ) {}

  async enrich(course: {
    description: string;
    department: string;
    code: string;
    title: string;
  }): Promise<EnrichmentResult> {
    if (this.aiRun === null) {
      throw new Error("Workers AI binding is not configured.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await this.aiRun(this.model, {
        prompt: `You are a curriculum editor. Given the course below, return strict JSON only with these fields:
- "summary": plain-text summary of the course, 60 words or fewer.
- "tags": 3 to 6 short topic tags.
- "suggestedPrerequisites": course IDs (prefixed with crs_) that are sensible prerequisites, chosen ONLY from this catalog: ${[
          ...this.validCourseIds,
        ].join(", ")}.

Course:
- code: ${course.code}
- title: ${course.title}
- department: ${course.department}
- description: ${course.description}

Return only valid JSON. No markdown fences, no explanation.`,
      },
      { signal: controller.signal },
    );

    const raw =
      response !== null && typeof response === "object" && "response" in response
        ? (response as { response?: unknown }).response
        : response;

    let text: string;

    if (typeof raw === "string") {
      text = raw;
    } else if (raw !== null && typeof raw === "object") {
      text = JSON.stringify(raw);
    } else {
      throw new Error("Workers AI returned an unparseable response.");
    }

    const cleaned = text.replace(/^```json\s*/, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    const validated = EnrichmentAiOutputSchema.parse(parsed);

    const suggestedPrerequisites = validated.suggestedPrerequisites.filter(
      (courseId) => this.validCourseIds.has(courseId),
    );

    return {
      summary: validated.summary,
      tags: validated.tags,
      suggestedPrerequisites,
      source: "ai",
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`AI enrichment failed validation: ${error.message}`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
  }
}

export class EnrichmentService implements EnrichmentProvider {  constructor(
    private readonly primary: EnrichmentProvider,
    private readonly fallback: EnrichmentProvider,
  ) {}

  async enrich(course: {
    description: string;
    department: string;
    code: string;
    title: string;
  }): Promise<EnrichmentResult> {
    try {
      return await this.primary.enrich(course);
    } catch {
      return await this.fallback.enrich(course);
    }
  }
}

export async function loadValidCourseIds(
  db: D1Database,
): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT id FROM courses")
    .all<{ id: string }>();

  return new Set(rows.results.map((row) => row.id));
}
