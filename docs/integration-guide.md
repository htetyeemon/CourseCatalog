# Integration Guide — Course Catalog API

This guide helps partner teams integrate with the Course Catalog API. It covers
base URLs, authentication, every API operation with curl examples, webhook
subscription and signature verification, error codes, versioning policy, and
support contacts.

## 1. Base URLs

| Environment | Base URL | Notes |
| --- | --- | --- |
| Production | `https://api.course-catalog.dev` | Serves the production Worker. |
| Staging | `https://course-catalog-staging.example.com` | Pre-production mirror; data resets on deploy. |
| Local development | `http://127.0.0.1:8787` | Run `npm run dev` after `wrangler install` and secrets setup. |

All routes are served under `/v1`. Health is public: `GET /v1/health`.

## 2. Authentication

Every operation except `GET /v1/health` requires a Bearer JWT:

```http
Authorization: Bearer <jwt>
```

### Getting a test token (development only)

The `scripts/mint-dev-token.mjs` script mints HS256 JWTs for each role. It reads
`JWT_SECRET` from `.dev.vars` or the environment.

```bash
# Local development
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set JWT_SECRET to a strong random value
npm run migrate:local
npm run seed:local

# Mint a catalog_admin token
npm run token:dev -- --role catalog_admin --sub ins_01J9ZK5A1B2C3D4E5F6G7H8J01

# Mint a student token
npm run token:dev -- --role student --sub stu_01J9ZK6B2C3D4E5F6G7H8J9K0M

# Mint an instructor token
npm run token:dev -- --role instructor --sub ins_01J9ZK5A1B2C3D4E5F6G7H8J02

# Mint a service token
npm run token:dev -- --role service --sub svc_01J9ZK7C3D4E5F6G7H8J9K0M1N
```

Use the printed token as `Authorization: Bearer <token>`. Tokens are valid for
3600 seconds by default (`--expires` to change).

In production, tokens are issued by the catalog identity provider. Contact the
platform team for service credentials.

### Role matrix

| Role | Capabilities |
| --- | --- |
| `student` | Read courses/instructors; check own prerequisite eligibility. |
| `instructor` | Read courses/instructors; check eligibility for any student. |
| `catalog_admin` | Full course lifecycle, prerequisites, webhook subscriptions, delivery inspection. |
| `service` | Same machine capabilities as `catalog_admin`, subject to service-scoped credentials. |

## 3. API operations (curl examples)

Set `CATALOG_TOKEN` to your JWT before running examples:

```bash
export CATALOG_TOKEN="<your-jwt>"
export BASE_URL="https://api.course-catalog.dev"
```

### Courses

#### List or search courses

```bash
curl -s "$BASE_URL/v1/courses?limit=20&department=Computer%20Science&level=introductory" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

Search by keyword:

```bash
curl -s "$BASE_URL/v1/courses?q=algorithms&limit=10" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

#### Get a course

```bash
curl -s "$BASE_URL/v1/courses/crs_01J9ZK4Q7M2W8N5R3T6Y0B1C01" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

#### Create a course (catalog_admin, service)

```bash
curl -s -X POST "$BASE_URL/v1/courses" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "CS-201",
    "title": "Data Structures",
    "description": "Core data structures, complexity analysis, and implementation techniques.",
    "credits": 4,
    "level": "intermediate",
    "department": "Computer Science",
    "instructorIds": ["ins_01J9ZK5A1B2C3D4E5F6G7H8J9K"]
  }'
```

#### Update a course (catalog_admin, service)

```bash
curl -s -X PATCH "$BASE_URL/v1/courses/crs_01J9ZK4Q7M2W8N5R3T6Y0B1C01" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Data Structures and Algorithms",
    "credits": 4
  }'
```

#### Publish a course (catalog_admin, service)

```bash
curl -s -X POST "$BASE_URL/v1/courses/crs_01J9ZK4Q7M2W8N5R3T6Y0B1C01/publish" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

Publishing sets `status=published`, runs enrichment (AI with deterministic
fallback), stores `summary`/`tags`/`enrichment_source`, and enqueues a
`course.published` webhook to every active subscription.

### Prerequisites

#### Replace course prerequisites (catalog_admin, service)

```bash
curl -s -X PUT "$BASE_URL/v1/courses/crs_01J9ZK4Q7M2W8N5R3T6Y0B1C01/prerequisites" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prerequisites": [
      { "courseId": "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C02", "required": true, "minimumGrade": 60 },
      { "courseId": "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C03", "required": false }
    ]
  }'
```

Cycles and self-references are rejected with `422` and error codes
`prerequisite_cycle` / `prerequisite_self_reference`.

#### Check prerequisite eligibility

```bash
curl -s -X POST "$BASE_URL/v1/prerequisites/check" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "courseId": "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C01",
    "completedCourseIds": ["crs_01J9ZK4Q7M2W8N5R3T6Y0B1C02"]
  }'
```

Response: `{"eligible": true, "missing": []}`.

This endpoint considers **direct prerequisites only** (not the full transitive
chain). Optional prerequisites never block eligibility. Grades and student
records are not read.

### Instructors

#### List instructors

```bash
curl -s "$BASE_URL/v1/instructors?limit=20&department=Computer%20Science" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

#### Get an instructor

```bash
curl -s "$BASE_URL/v1/instructors/ins_01J9ZK5A1B2C3D4E5F6G7H8J9K" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

### Webhooks

#### Create a subscription (catalog_admin, service)

```bash
curl -s -X POST "$BASE_URL/v1/webhooks/subscriptions" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://lms.example.com/webhooks/catalog",
    "events": ["course.published"],
    "description": "LMS synchronization"
  }'
```

The response includes a one-time `signingSecret`. Store it securely — it is
never returned again.

#### List deliveries (catalog_admin, service)

```bash
curl -s "$BASE_URL/v1/webhooks/deliveries?status=failed&limit=20" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

Filters: `subscriptionId`, `eventId`, `status`, `eventType`, `page`, `limit`.

## 4. Webhook subscription walkthrough

### Step 1: Create the subscription

```bash
curl -s -X POST "$BASE_URL/v1/webhooks/subscriptions" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://lms.example.com/webhooks/catalog","events":["course.published"]}'
```

Response:

```json
{
  "data": {
    "id": "whs_01J9ZK7C3D4E5F6G7H8J9K0M1N",
    "url": "https://lms.example.com/webhooks/catalog",
    "events": ["course.published"],
    "status": "active",
    "signingSecret": "whsec_<32+ char secret>",
    "createdAt": "2026-03-01T15:00:00Z",
    "updatedAt": "2026-03-01T15:00:00Z"
  }
}
```

Save `signingSecret` — it is shown once and never returned again.

### Step 2: Receive a course.published event

When a course is published, your endpoint receives a POST with:

| Header | Description |
| --- | --- |
| `Content-Type` | `application/json; charset=utf-8` |
| `User-Agent` | `CourseCatalog-Webhooks/1.0` |
| `X-Catalog-Event` | `course.published` |
| `X-Catalog-Event-Id` | Event ID (stable across retries) |
| `X-Catalog-Delivery` | Delivery attempt ID (unique per attempt) |
| `X-Catalog-Signature` | `t=<unix>,v1=<hex hmac-sha256>` |

The body is the `CoursePublishedEvent` envelope.

### Step 3: Verify the signature (TypeScript)

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyCatalogSignature(
  rawBody: string,
  signatureHeader: string,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return false;

  const timestamp = Number(tPart.slice(2));
  const providedHex = v1Part.slice(3);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > 300) return false; // 5-minute replay window
  if (!/^[a-f0-9]{64}$/.test(providedHex)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(providedHex),
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
}

// In your request handler:
const rawBody = await request.text();
const signature = request.headers.get("x-catalog-signature") ?? "";
if (!(await verifyCatalogSignature(rawBody, signature, signingSecret))) {
  return new Response("invalid signature", { status: 401 });
}
const event = JSON.parse(rawBody);
// Deduplicate by event.id before processing
```

### Step 3: Verify the signature (Python)

```python
import hmac
import hashlib
import time

def verify_catalog_signature(raw_body: str, signature_header: str, signing_secret: str, now_seconds: int = None) -> bool:
    if now_seconds is None:
        now_seconds = int(time.time())

    parts = signature_header.split(",")
    t_part = next((p for p in parts if p.startswith("t=")), None)
    v1_part = next((p for p in parts if p.startswith("v1=")), None)
    if not t_part or not v1_part:
        return False

    timestamp = int(t_part[2:])
    provided_hex = v1_part[3:]

    if abs(now_seconds - timestamp) > 300:
        return False  # 5-minute replay window
    if not re.fullmatch(r"[a-f0-9]{64}", provided_hex):
        return False

    expected = hmac.new(
        signing_secret.encode("utf-8"),
        f"{timestamp}.{raw_body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(expected, provided_hex)


# In your request handler:
raw_body = await request.body()
signature = request.headers.get("x-catalog-signature", "")
if not verify_catalog_signature(raw_body, signature, signing_secret):
    return Response("invalid signature", status_code=401)
event = await request.json()
# Deduplicate by event["id"] before processing
```

### Step 4: Respond and deduplicate

- Return any `2xx` only after durably accepting the event.
- Deduplicate by the envelope `id` (also `X-Catalog-Event-Id`). Retries share
  the same event ID but have different `X-Catalog-Delivery` values.
- Retain processed event IDs for at least 7 days.
- `410 Gone` disables the subscription immediately.
- Max 6 attempts per event with exponential backoff (30s, 2min, 8min, 32min,
  2h).

## 5. Error codes

All errors use the envelope:

```json
{
  "error": {
    "code": "<code>",
    "message": "<human readable>",
    "details": { ... },
    "requestId": "req_<...>"
  }
}
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Malformed request or invalid parameters. |
| `validation_failed` | 422 | Business rule violation (includes `details.fields`). |
| `unauthorized` | 401 | Missing, expired, or invalid Bearer token. |
| `forbidden` | 403 | Valid token but role/subject not allowed. |
| `not_found` | 404 | Resource does not exist. |
| `conflict` | 409 | State conflict (e.g. duplicate course code, already published). |
| `prerequisite_cycle` | 422 | Prerequisite change would introduce a cycle. |
| `prerequisite_self_reference` | 422 | A course cannot be its own prerequisite. |
| `rate_limited` | 429 | Too many requests. See `Retry-After` header. |
| `internal_error` | 500 | Unexpected server error. |
| `service_unavailable` | 503 | Dependency (database/AI) unavailable. |

Include `requestId` when reporting issues.

## 6. Rate limiting

- `/v1/*` endpoints are rate-limited per client IP + path.
- Default: 100 requests per minute per endpoint.
- Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- `429 rate_limited` with `Retry-After` header when exceeded.

## 7. Versioning and deprecation policy

- API version is in the URL path: `/v1`.
- Breaking changes require a new major version (e.g. `/v2`).
- Non-breaking changes (new fields, optional parameters) are additive and
  backward-compatible.
- Webhook event versions are independent: `course.published` is `1.0`. New
  event versions are additive; consumers should ignore unknown fields.
- Deprecation notices are posted to the platform team channel and the API
  changelog at least 90 days before removal.

## 8. Contact and escalation

| Need | Contact |
| --- | --- |
| API questions, integration issues | Course Catalog Platform Team: platform-team@example.com |
| Urgent production incident | #platform-oncall (Slack) or +1-555-0100 |
| Token / credential requests | platform-team@example.com |
| Webhook delivery failures | Check `GET /v1/webhooks/deliveries`, then contact platform team |

Include `requestId`, timestamp, and the full request/response (minus secrets)
when reporting issues.

## 9. Client libraries and tools

- OpenAPI contract: `openapi.yaml` at the repository root, served as
  `GET /openapi.json`.
- Postman/Bruno collection: `postman_collection.json` (generated from
  `openapi.yaml` via `npm run collection:postman`).
- Dev token minting: `npm run token:dev`.
- Smoke test (staging): `JWT_SECRET=... npm run smoke:staging`.
