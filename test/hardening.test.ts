import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import app from "../src/index.js";
import { structuredLog } from "../src/lib/logger.js";
import { AiEnrichmentProvider } from "../src/lib/enrichment.js";
import { CreateWebhookSubscriptionRequestSchema } from "../src/schemas/webhook.js";
import { applyTestMigrations, resetTestState, env } from "./helpers/db.js";
import { authHeaders, ROLES } from "./helpers/tokens.js";

function request(input: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.fetch(new Request("http://localhost" + input, init), env));
}

describe("structured logger redaction", () => {
  it("keeps request fields verbatim and redacts secrets by key and token pattern", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      structuredLog({
        level: "info",
        timestamp: "2026-01-01T00:00:00.000Z",
        requestId: "req_abc123def456",
        method: "GET",
        path: "/v1/courses",
        status: 200,
        latencyMs: 12,
        message: "GET /v1/courses 200",
        error:
          "rejected Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdHVfMDEifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const out = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(out.method).toBe("GET");
      expect(out.path).toBe("/v1/courses");
      expect(out.requestId).toBe("req_abc123def456");
      expect(out.message).toBe("GET /v1/courses 200");
      expect(out.status).toBe(200);
      expect(out.error).toBe("rejected [redacted]");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("webhook subscription URL hardening", () => {
  const base = { events: ["course.published"] as const };

  it("accepts a public https hostname", () => {
    expect(
      CreateWebhookSubscriptionRequestSchema.safeParse({
        ...base,
        url: "https://lms.example.com/webhooks/catalog",
      }).success,
    ).toBe(true);
  });

  it.each([
    "https://localhost/hook",
    "https://app.localhost/hook",
    "https://127.0.0.1/hook",
    "https://10.0.0.5:8443/hook",
    "https://[::1]/hook",
    "https://metadata.internal/hook",
    "https://user:pass@lms.example.com/hook",
    "https://intranet/hook",
  ])("rejects %s", (url) => {
    expect(CreateWebhookSubscriptionRequestSchema.safeParse({ ...base, url }).success).toBe(false);
  });
});

describe("webhook subscription listing authorization", () => {
  beforeAll(async () => {
    await applyTestMigrations();
  });

  afterEach(async () => {
    await resetTestState();
  });

  it("is forbidden for students and instructors but allowed for catalog admins", async () => {
    const student = await request("/v1/webhooks/subscriptions", {
      headers: authHeaders(env, ROLES.STUDENT),
    });
    expect(student.status).toBe(403);

    const instructor = await request("/v1/webhooks/subscriptions", {
      headers: authHeaders(env, ROLES.INSTRUCTOR),
    });
    expect(instructor.status).toBe(403);

    const admin = await request("/v1/webhooks/subscriptions", {
      headers: authHeaders(env, ROLES.CATALOG_ADMIN),
    });
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as { data: unknown[]; total: number };
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe("AI enrichment response parsing", () => {
  const course = {
    code: "CS-101",
    title: "Intro",
    department: "Computer Science",
    description: "Foundations.",
  };

  it("accepts OpenAI-style completions in code fences and filters unknown prerequisite IDs", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [
        {
          text: [
            "```json",
            JSON.stringify({
              summary: "Short summary.",
              tags: ["intro", "cs"],
              suggestedPrerequisites: ["crs_known00000001", "CS-100"],
              extra: 1,
            }),
            "```",
          ].join("\n"),
        },
      ],
    });
    const provider = new AiEnrichmentProvider(run, new Set(["crs_known00000001"]), "@cf/test/model");
    const result = await provider.enrich(course);
    expect(result).toEqual({
      summary: "Short summary.",
      tags: ["intro", "cs"],
      suggestedPrerequisites: ["crs_known00000001"],
      source: "ai",
    });
    expect(run).toHaveBeenCalledWith(
      "@cf/test/model",
      expect.objectContaining({
        response_format: expect.objectContaining({ type: "json_schema" }),
      }),
    );
  });

  it("still accepts the legacy { response } shape", async () => {
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify({ summary: "Legacy.", tags: ["a"], suggestedPrerequisites: [] }),
    });
    const provider = new AiEnrichmentProvider(run, new Set());
    await expect(provider.enrich(course)).resolves.toMatchObject({ summary: "Legacy.", source: "ai" });
  });

  it("rejects answers without a JSON object so the service falls back", async () => {
    const run = vi.fn().mockResolvedValue({ choices: [{ text: "I cannot help with that." }] });
    const provider = new AiEnrichmentProvider(run, new Set(), "@cf/test/model");
    await expect(provider.enrich(course)).rejects.toThrow(/JSON object/);
  });
});
