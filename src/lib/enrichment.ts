import { z } from "zod";

// Lenient on purpose: unknown keys are dropped and malformed arrays become empty,
// so a slightly off model answer still yields an AI summary. Prerequisite IDs are
// filtered against the catalog afterwards.
const EnrichmentAiOutputSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).catch([]),
  suggestedPrerequisites: z.array(z.string()).max(50).catch([]),
});

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

export type AiRun = (
  model: string,
  input: {
    prompt: string;
    max_tokens?: number;
    response_format?: { type: "json_schema"; json_schema: Record<string, unknown> };
  },
) => Promise<unknown>;

// Overridable per environment with the AI_MODEL var. Workers AI retires models
// (error 5028); a retired model would silently force the fallback on every publish.
export const DEFAULT_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const AI_TIMEOUT_MS = 8000;

const enrichmentJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    suggestedPrerequisites: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "tags", "suggestedPrerequisites"],
};

// Models answer either as { response } or as an OpenAI-style completion
// ({ choices: [{ text | message.content }] }).
function extractText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }

  if (response !== null && typeof response === "object") {
    const r = response as {
      response?: unknown;
      choices?: Array<{ text?: unknown; message?: { content?: unknown } }>;
    };
    if (typeof r.response === "string") return r.response;
    if (r.response !== null && typeof r.response === "object") return JSON.stringify(r.response);
    const choice = r.choices?.[0];
    if (typeof choice?.text === "string") return choice.text;
    if (typeof choice?.message?.content === "string") return choice.message.content;
    return JSON.stringify(response);
  }

  throw new Error("Workers AI returned an unparseable response.");
}

function parseJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Workers AI response did not contain a JSON object.");
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export class AiEnrichmentProvider implements EnrichmentProvider {
  constructor(
    private readonly aiRun: AiRun | null,
    private readonly validCourseIds: Set<string>,
    private readonly model: string = DEFAULT_AI_MODEL,
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

    // The AI binding ignores abort signals, so the budget is enforced with a race;
    // a late AI response is discarded.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Workers AI enrichment timed out.")), AI_TIMEOUT_MS);
    });

    try {
      const aiCall = this.aiRun(this.model, {
        prompt: `You are a curriculum editor. Given the course below, return strict JSON only with these fields:
- "summary": plain-text summary of the course, 60 words or fewer.
- "tags": 3 to 6 short topic tags.
- "suggestedPrerequisites": course IDs (prefixed with crs_) that are sensible prerequisites, chosen ONLY from this catalog: ${[...this.validCourseIds].slice(0, 200).join(", ")}.

Course:
- code: ${course.code}
- title: ${course.title}
- department: ${course.department}
- description: ${course.description}

Return only valid JSON. No markdown fences, no explanation.`,
        max_tokens: 512,
        response_format: { type: "json_schema", json_schema: enrichmentJsonSchema },
      });
      aiCall.catch(() => undefined);
      const response = await Promise.race([aiCall, timeout]);
      const validated = EnrichmentAiOutputSchema.parse(parseJsonObject(extractText(response)));

      return {
        summary: validated.summary,
        tags: validated.tags,
        suggestedPrerequisites: validated.suggestedPrerequisites.filter((courseId) =>
          this.validCourseIds.has(courseId),
        ),
        source: "ai",
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`AI enrichment failed validation: ${error.message}`);
      }

      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

export class EnrichmentService implements EnrichmentProvider {
  constructor(
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
    } catch (error) {
      // Surface why AI enrichment was skipped; the fallback keeps publishing available.
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "enrichment_fallback",
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        }),
      );
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
