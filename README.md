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

Students can sign in through the browser at `/` using Student Identity. The
Worker verifies identity tokens with Student Identity on each API request.
Catalog-issued development tokens remain available for local administrative
work.

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

The full runbook is in [docs/deployment.md](docs/deployment.md): one-time account
setup (D1, secrets), migrations, verification, CI/CD, rollback, and operations.

Quick reference once an environment is bootstrapped:

```bash
npx wrangler whoami                       # confirm the Cloudflare account first
npm run migrate:remote -- --env staging   # apply new D1 migrations (production: --env production)
npm run deploy:staging                    # deploy staging (production: npm run deploy:prod)
BASE_URL=https://course-catalog-staging.taskflow-123.workers.dev JWT_SECRET=... npm run smoke:staging
```

| Environment | URL |
| --- | --- |
| Staging | https://course-catalog-staging.taskflow-123.workers.dev |
| Production | https://course-catalog.taskflow-123.workers.dev |

Pushes to `main`/`master` deploy staging through
[.github/workflows/deploy.yml](.github/workflows/deploy.yml); production is a
manual "Run workflow" of the same workflow. It needs the repository secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

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
  smoke-test.mjs               # End-to-end smoke test against a deployed environment
test/
  helpers/tokens.ts            # JWT minting helpers
  helpers/db.ts                # D1 migration helpers
  api.test.ts                  # Courses, prerequisites, authz, pagination
  publish.test.ts              # Enrichment fallback/AI success
  webhooks.test.ts             # Signature verification, delivery retry
  scheduled.test.ts            # Cron Trigger handler (webhook retry processing)
  contract.test.ts             # Responses validated against openapi.yaml
  openapi.test.ts              # OpenAPI contract validity
  schemas.test.ts              # Zod schema unit tests
docs/
  auth.md                      # Authentication and authorization
  webhooks.md                  # Webhook delivery contract
  integration-guide.md         # Partner integration guide
  deployment.md                # Cloudflare deployment runbook
```

## Testing

Tests run against a real local D1 via the Cloudflare Workers Vitest pool
(`@cloudflare/vitest-plugin`). D1 migrations are applied before each test file
and state is reset between tests.

```bash
npm test
```

Migrations are read in `vitest.config.ts` and handed to the Workers runtime as
the `TEST_MIGRATIONS` binding, so the whole suite runs locally on any OS and in
CI without a `.dev.vars` file.

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
