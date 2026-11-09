# Course Catalog API

Contract-first API for courses, instructors, prerequisites, and webhooks, built
on Cloudflare Workers, Hono, Zod, and D1.

## Prerequisites

- Node.js 24+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and
  authenticated (`wrangler login`)
- A Cloudflare account with D1 and Workers AI enabled

## Local development

```bash
# Install dependencies
npm install

# Copy dev vars and set JWT_SECRET
cp .dev.vars.example .dev.vars
# Edit .dev.vars: set JWT_SECRET to a strong random value (32+ bytes)

# Apply migrations and seed data locally
npm run migrate:local
npm run seed:local

# Start the dev server
npm run dev

# Mint a dev token (catalog_admin)
npm run token:dev -- --role catalog_admin --sub ins_01J9ZK5A1B2C3D4E5F6G7H8J01
```

## Available scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start local Wrangler dev server |
| `npm run typecheck` | Run TypeScript type checking |
| `npm test` | Run the Vitest test suite |
| `npm run lint:openapi` | Lint the OpenAPI contract |
| `npm run validate:contract` | Lint + typecheck + test |
| `npm run collection:postman` | Generate Postman/Bruno collection from openapi.yaml |
| `npm run migrate:local` | Apply D1 migrations to local database |
| `npm run migrate:remote` | Apply D1 migrations to remote database |
| `npm run seed:local` | Seed local database |
| `npm run seed:remote` | Seed remote database |
| `npm run token:dev` | Mint a development JWT (dev-only) |
| `npm run smoke:staging` | Run end-to-end smoke test against staging |

## Deployment

### Staging

1. Set the staging secret:

```bash
wrangler secret put JWT_SECRET --env staging
```

2. Apply D1 migrations to staging:

```bash
npm run migrate:remote -- --env staging
```

3. (Optional) Seed staging data:

```bash
npm run seed:remote -- --env staging
```

4. Deploy to staging:

```bash
npm run deploy:staging
```

Equivalent wrangler commands:

```bash
wrangler secret put JWT_SECRET --env staging
wrangler d1 migrations apply DB --remote --env staging
wrangler deploy --env staging
```

### Production

1. Set the production secret:

```bash
wrangler secret put JWT_SECRET --env production
```

2. Apply D1 migrations to production:

```bash
npm run migrate:remote -- --env production
```

3. (Optional) Seed production data:

```bash
npm run seed:remote -- --env production
```

4. Deploy to production:

```bash
npm run deploy:prod
```

Equivalent wrangler commands:

```bash
wrangler secret put JWT_SECRET --env production
wrangler d1 migrations apply DB --remote --env production
wrangler deploy --env production
```

### Deployment checklist

- [ ] `JWT_SECRET` set for the target environment (`wrangler secret put`)
- [ ] D1 migrations applied (`wrangler d1 migrations apply DB --remote --env <env>`)
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run lint:openapi` passes

## Project structure

```
src/
  index.ts            # Worker entry point (fetch + cron)
  lib/
    auth.ts           # JWT verification, requireRole guard
    jwt.ts            # HS256 JWT verifier (pluggable verifiers for JWKS/RS256)
    enrichment.ts     # AI + deterministic enrichment providers
    delivery.ts       # Webhook delivery, HMAC signatures, retry/backoff
    logger.ts         # Structured JSON logging with requestId
    rate-limit.ts     # Per-IP+path rate limiting middleware
    errors.ts         # Standardized error envelope
    validation.ts     # JSON body parsing + Zod validation
    ids.ts            # ID generation (crs_, ins_, whs_, whd_, evt_, req_)
    request-id.ts     # Request ID middleware
  db/
    courses.ts        # Course queries
    instructors.ts    # Instructor queries
    prerequisites.ts  # Prerequisite CRUD + cycle detection
    webhooks.ts       # Subscription + delivery persistence
    shared.ts         # Shared DB helpers
  routes/
    courses.ts        # GET/POST/PATCH /v1/courses, POST /v1/courses/{id}/publish
    prerequisites.ts  # PUT /v1/courses/{id}/prerequisites, POST /v1/prerequisites/check
    webhooks.ts       # POST/GET /v1/webhooks/subscriptions, GET /v1/webhooks/deliveries
    instructors.ts    # GET /v1/instructors
    health.ts         # GET /v1/health
  schemas/
    course.ts, instructor.ts, prerequisite.ts, webhook.ts, common.ts
  openapi.json        # Generated OpenAPI document
public/
  index.html          # API landing page
  course.html         # Course detail browser
  admin.html          # Admin console
  css/app.css         # Shared styles
  js/api.js           # API client + XSS-safe helpers
  js/ui.js            # UI helpers (loading, error, token banner)
migrations/
  0001_init.sql       # Initial schema
  0002_webhook_delivery_body.sql  # Delivery request body column
scripts/
  generate-openapi-json.mjs
  generate-postman-collection.mjs
  mint-dev-token.mjs           # Dev-only JWT minter
  smoke-test.mjs               # End-to-end staging smoke test
test/
  helpers/tokens.ts            # JWT minting helpers
  helpers/db.ts                # D1 migration helpers
  api.test.ts                  # Courses, prerequisites, authz, pagination
  publish.test.ts              # Enrichment fallback/AI success
  webhooks.test.ts             # Signature verification, delivery retry
  contract.test.ts             # Responses validated against openapi.yaml
  openapi.test.ts              # OpenAPI contract validity
  schemas.test.ts              # Zod schema unit tests
docs/
  auth.md                      # Authentication and authorization
  webhooks.md                  # Webhook delivery contract
  integration-guide.md         # Partner integration guide
```

## Testing

Tests run against a real local D1 via the Cloudflare Workers Vitest pool
(`@cloudflare/vitest-plugin`). D1 migrations are applied before each test file
and state is reset between tests.

```bash
npm test
```

The D1-backed integration tests (courses, prerequisites, publish, webhooks)
require the workers pool and run on CI (Linux). Schema and OpenAPI contract
tests run locally.

## Contract

The API contract is defined in `openapi.yaml`. The served `openapi.json` is
generated from it via `scripts/generate-openapi-json.mjs`. Zod schemas in
`src/schemas` mirror the OpenAPI schemas. A contract-conformance test
(`test/contract.test.ts`) validates real Worker responses against the OpenAPI
JSON schemas to prevent spec drift.

## Postman / Bruno collection

Generate from `openapi.yaml`:

```bash
npm run collection:postman
```

Output: `postman_collection.json` (importable into Postman or Bruno).

## Integration guide

See `docs/integration-guide.md` for base URLs, curl examples for every
operation, webhook signature verification (TypeScript + Python), error codes,
versioning policy, and contact information.

## License

Proprietary. See `openapi.yaml` for license details.
