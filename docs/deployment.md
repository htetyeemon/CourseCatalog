# Deployment Runbook — Cloudflare

This document covers deploying the Course Catalog Worker to Cloudflare, from an
empty account to a verified environment, plus day-two operations.

## What a deployment consists of

| Resource | Staging | Production |
| --- | --- | --- |
| Worker | `course-catalog-staging` | `course-catalog` |
| D1 database | `course-catalog-staging` | `course-catalog-production` |
| Workers AI binding | `AI` | `AI` |
| Cron Trigger | `*/5 * * * *` (webhook retries) | `*/5 * * * *` |
| Static assets | `public/` served at `/` | `public/` served at `/` |
| URL | `https://course-catalog-staging.<subdomain>.workers.dev` | `https://course-catalog.<subdomain>.workers.dev` |

`<subdomain>` is the account's `workers.dev` subdomain. Everything fits in the
Workers Free plan; Workers AI has a free daily allocation and enrichment falls
back to a deterministic summary when AI is unavailable.

Configuration lives in [`wrangler.jsonc`](../wrangler.jsonc). The top-level
settings are the local development profile; `env.staging` and `env.production`
hold the deployable environments. Always pass `--env` (the npm scripts do).

## Current deployment

| Environment | URL | Account |
| --- | --- | --- |
| Staging | https://course-catalog-staging.taskflow-123.workers.dev | Cloudflare account `3b9a48e10bf1c01caad3635157aaac63` (workers.dev subdomain `taskflow-123`) |
| Production | https://course-catalog.taskflow-123.workers.dev | same account |

## Prerequisites

- Node.js 24 and `npm ci`
- A Cloudflare account with a registered `workers.dev` subdomain
  (Dashboard → Workers & Pages → Overview → "Set up a subdomain")
- Wrangler authenticated as that account:

```bash
npx wrangler login
npx wrangler whoami   # confirm the email and account ID before deploying
```

## One-time setup per environment

Replace `staging` with `production` for the second environment.

1. **Create the D1 database** and copy its ID into `wrangler.jsonc`
   (`env.staging.d1_databases[0].database_id`). Database IDs are not secrets
   and are committed.

   ```bash
   npx wrangler d1 create course-catalog-staging
   ```

2. **Set the JWT secret.** Generate a strong value, store it in your password
   manager (it is needed to mint tokens), then upload it. Deploys fail while
   this secret is missing because it is declared in `secrets.required`.

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   npx wrangler secret put JWT_SECRET --env staging
   ```

   The maintainers of this deployment keep the generated values in the gitignored
   files `.dev.vars.staging` and `.dev.vars.production` (`wrangler dev --env <env>`
   also reads them). Treat those files like a password manager entry.

3. **Apply migrations.**

   ```bash
   npm run migrate:remote -- --env staging
   ```

4. **Seed sample data** (optional, idempotent `INSERT OR IGNORE`).

   ```bash
   npm run seed:remote -- --env staging
   ```

## Deploy

```bash
npm run deploy:staging      # wrangler deploy --env staging
npm run deploy:prod         # wrangler deploy --env production
```

Wrangler prints the Worker URL and the Cron Trigger it registered. The first
request after a deploy can take a few seconds to propagate.

## Verify

```bash
export BASE_URL=https://course-catalog-staging.<subdomain>.workers.dev

# Public health check (database + AI binding)
curl -s "$BASE_URL/v1/health"

# Mint an admin token with the environment's JWT_SECRET, then call the API
export JWT_SECRET='<the staging secret>'
TOKEN=$(npm run -s token:dev -- --role catalog_admin --sub ins_01J9ZK5A1B2C3D4E5F6G7H8J01)
curl -s "$BASE_URL/v1/courses?limit=3" -H "Authorization: Bearer $TOKEN"

# End-to-end publish flow: creates and publishes one SMOKE-NNNN course, which stays
# in the catalog, so run it against staging only
BASE_URL=$BASE_URL JWT_SECRET=$JWT_SECRET npm run smoke:staging

# Live logs
npx wrangler tail --env staging
```

The static frontend is served at `$BASE_URL/` (browse), `/course.html`, and
`/admin.html`. Paste the token into the banner; it is held in memory only.

## Releasing changes

- **Code changes**: run the deploy command again. Wrangler keeps previous
  versions; roll back with `npx wrangler rollback --env <env>`.
- **Schema changes**: add `migrations/000N_<name>.sql`, run
  `npm run migrate:remote -- --env <env>`, then deploy. Migrations are applied
  before the new code is live, so they must be backward compatible with the
  currently running Worker (add columns, do not drop or rename in one step).
- **Rotating `JWT_SECRET`**: `wrangler secret put JWT_SECRET --env <env>` again.
  All tokens signed with the old secret stop working immediately.
- **Config changes** (vars, cron schedule, bindings): edit `wrangler.jsonc` and
  deploy; Cron Trigger changes can take up to 15 minutes to propagate.

## CI/CD (GitHub Actions)

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys
staging on every push to `main`/`master` and production via **Run workflow**
with `environment=production`. Each run typechecks, tests, lints the OpenAPI
contract, applies migrations, deploys, and health-checks the URL.

Add these secrets to the repository (or to the `staging` / `production`
GitHub environments):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Account API token: Dashboard → Manage account → Account API tokens → Create token → "Edit Cloudflare Workers" template, plus **D1: Edit** and **Workers AI: Read** |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID shown by `npx wrangler whoami` |

Protect the `production` GitHub environment with required reviewers to gate
production deploys behind an approval.

## Operational notes

- **Rate limiting** is an in-memory, per-isolate best-effort limiter keyed by
  `CF-Connecting-IP` and path. For hard limits use Cloudflare Rate Limiting
  rules or the Workers Rate Limiting binding.
- **Authentication** uses HS256 with a shared secret; see
  [`auth.md`](./auth.md) for the planned JWKS migration.
- **Webhook retries** are driven by the Cron Trigger, so retry delays are
  quantized to the 5-minute schedule. Inspect deliveries with
  `GET /v1/webhooks/deliveries` as a `catalog_admin`.
- **Observability**: Workers Logs is enabled (`observability.enabled`). Use
  `wrangler tail` for live logs and the dashboard for history.
- **Workers AI model**: set by the `AI_MODEL` var (default
  `@cf/meta/llama-4-scout-17b-16e-instruct`). Cloudflare retires models (error
  5028); when publishes start logging `enrichment_fallback` in `wrangler tail`, pick a
  current text-generation model from `npx wrangler ai models`, update the var, and redeploy.
- **Custom domain**: add `"routes": [{ "pattern": "api.example.com", "custom_domain": true }]`
  to the environment in `wrangler.jsonc`, deploy, then update the base URLs in
  `openapi.yaml` and the integration guide.
- **Local development** uses a local SQLite D1 (`npm run migrate:local`,
  `npm run seed:local`, `npm run dev`); the AI binding always calls the remote
  service, even locally.
