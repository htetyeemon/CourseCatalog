# Authentication and Authorization

The Course Catalog API uses Bearer JWTs. All operations except
`GET /v1/health` and `POST /v1/auth/login` require an `Authorization` header:

```http
Authorization: Bearer <jwt>
```

The browser login page sends student ID and password to the Course Catalog
login proxy. The proxy forwards credentials to Student Identity over HTTPS;
Course Catalog does not store passwords. The returned token is held in browser
memory only. The API does not accept tokens in query strings or cookies.

For Student Identity tokens, every authenticated API request is checked by
`POST https://student-identity.onrender.com/tokens/verify` with
`{"token":"<jwt>"}`. The verifier response, not locally decoded JWT claims,
determines the subject and role. Student identities map to the Course Catalog
`student` role; instructor identities map to `instructor`. Staff identities
are not granted catalog staff or administrator access. Verification fails
closed when Student Identity is unavailable. Existing catalog-issued HS256
tokens remain supported for service and development use.

## Catalog-issued token profile

Tokens are compact-serialized JWTs issued by the catalog identity provider.
The current Worker verifies `HS256` tokens using the `JWT_SECRET` Worker
secret. `alg: none` and all other algorithms are rejected. The verifier is
structured so production can migrate to asymmetric keys and JWKS without
changing route authorization. Do not use the shared HS256 secret outside
trusted Worker development and deployment environments.

### Required claims

| Claim | Type | Description |
| --- | --- | --- |
| `sub` | string | Stable subject identifier. Students use their `stu_` ID, instructors use their `ins_` ID, and service tokens use a stable service principal identifier. |
| `role` | string | One of `student`, `instructor`, `catalog_admin`, or `service`. |
| `iss` | string | Issuer. Must equal `JWT_ISSUER`, defaulting to `https://auth.course-catalog.dev`. |
| `exp` | integer | Expiry time as Unix seconds. |

Optional claims:

| Claim | Type | Description |
| --- | --- | --- |
| `iat` | integer | Issued-at time as Unix seconds. |
| `nbf` | integer | Not-before time as Unix seconds. |
| `jti` | string | Unique token identifier, useful for audit and revocation. |
| `aud` | string or string array | Audience. If present, it must include `JWT_AUDIENCE`, defaulting to `catalog-api`. |

Example decoded payload:

```json
{
  "sub": "stu_01J9ZK6B2C3D4E5F6G7H8J9K0M",
  "role": "student",
  "iss": "https://auth.course-catalog.dev",
  "exp": 1772377200,
  "iat": 1772376900,
  "aud": "catalog-api"
}
```

### Issuer and verification keys

- Issuer: `JWT_ISSUER` (`https://auth.course-catalog.dev` by default)
- API audience: `JWT_AUDIENCE` (`catalog-api` by default)
- Current algorithm: `HS256` with `JWT_SECRET`

The shared HS256 secret is configured with `wrangler secret put JWT_SECRET --env <staging|production>` and
must never be committed, logged, or returned by an endpoint. For local
development, put a strong random value in `.dev.vars`.

The intended production profile is asymmetric signing with a JWKS endpoint.
When that migration happens, the verifier will select a key by `kid`, cache the
JWKS response, and refresh it when an unknown `kid` is encountered.

## Roles

| Role | Typical principal | Capabilities |
| --- | --- | --- |
| `student` | A learner | Read courses and instructors; check their own prerequisite eligibility. |
| `instructor` | A teacher | Read courses and instructors; check eligibility for any student. |
| `catalog_admin` | A catalog operator | Full course lifecycle, prerequisites, webhook subscriptions, and delivery inspection. |
| `service` | A trusted machine client | Same machine capabilities as a catalog administrator, subject to service-scoped credentials. |

### Operation role matrix

| Operation | Method and path | Required roles |
| --- | --- | --- |
| `listCourses` | `GET /v1/courses` | `student`, `instructor`, `catalog_admin`, `service` |
| `getCourse` | `GET /v1/courses/{courseId}` | `student`, `instructor`, `catalog_admin`, `service` |
| `createCourse` | `POST /v1/courses` | `catalog_admin`, `service` |
| `updateCourse` | `PATCH /v1/courses/{courseId}` | `catalog_admin`, `service` |
| `publishCourse` | `POST /v1/courses/{courseId}/publish` | `catalog_admin`, `service` |
| `listInstructors` | `GET /v1/instructors` | `student`, `instructor`, `catalog_admin`, `service` |
| `getInstructor` | `GET /v1/instructors/{instructorId}` | `student`, `instructor`, `catalog_admin`, `service` |
| `putCoursePrerequisites` | `PUT /v1/courses/{courseId}/prerequisites` | `catalog_admin`, `service` |
| `checkPrerequisiteCompletion` | `POST /v1/prerequisites/check` | `student`, `instructor`, `catalog_admin`, `service` |
| `checkPrerequisiteEligibility` | `POST /v1/courses/{courseId}/eligibility-check` | Contract only; not implemented by the current Worker |
| `createWebhookSubscription` | `POST /v1/webhooks/subscriptions` | `catalog_admin`, `service` |
| `listWebhookDeliveries` | `GET /v1/webhooks/deliveries` | `catalog_admin`, `service` |
| `getHealth` | `GET /v1/health` | Public |

`checkPrerequisiteCompletion` is stateless: only direct prerequisites marked
required are evaluated, and optional prerequisites never block eligibility.
Grades and student records are not read. The older student-record-based
`checkPrerequisiteEligibility` operation is not implemented by this Worker.

## Calling the API

Use an access token from the identity provider. Store tokens in a secure
credential store or environment variable, never in source code.

```bash
curl -s "https://api.course-catalog.dev/v1/courses?limit=20&status=published" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

Create a course as a catalog administrator or service:

```bash
curl -s -X POST "https://api.course-catalog.dev/v1/courses" \
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

Check direct prerequisites using completed course IDs:

```bash
curl -s -X POST "https://api.course-catalog.dev/v1/prerequisites/check" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "courseId": "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2D",
    "completedCourseIds": ["crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2E"]
  }'
```

The response lists required direct prerequisites that are still missing:

```json
{
  "eligible": false,
  "missing": ["crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2F"]
}
```

Health is public:

```bash
curl -s "https://api.course-catalog.dev/v1/health"
```

## Failure responses

Authentication and authorization failures use the standard error envelope:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "A valid Bearer token is required.",
    "requestId": "req_01J9ZKAF6G7H8J9K0M1N2P3Q4R"
  }
}
```

- `401 unauthorized`: token is missing, malformed, expired, has an untrusted
  issuer, an unsupported algorithm, or an invalid signature.
- `403 forbidden`: the token is valid but the role or subject is not allowed to
  perform the operation.

Include the `requestId` when reporting an issue.

## Verifying tokens in Cloudflare Workers

The current verifier uses the Workers runtime's built-in Web Crypto API.

1. Read the `Authorization` header. Require the `Bearer` scheme and a
   non-empty token.
2. Split the compact JWT into header, payload, and signature segments. Reject
   malformed tokens.
3. Decode the header and payload as JSON. Do not trust either until the
   signature is verified.
4. Reject any `alg` other than `HS256`.
5. Import `JWT_SECRET` as an HMAC SHA-256 key and verify the signature with
   `crypto.subtle.verify`.
6. Validate `iss` exactly against `JWT_ISSUER`.
7. Validate `exp` against the current Unix time with a 60-second clock skew
   allowance. If `nbf` is present, validate it with the same allowance. If
   `aud` is present, require `JWT_AUDIENCE`.
8. Validate that `role` is a known role and is allowed for the operation.
9. Attach an internal auth context such as `{ sub, role }` to the request.
   Never pass the raw token to downstream services or logs.

Recommended token handling:

- Use HTTPS only.
- Keep access tokens short-lived.
- Rotate `JWT_SECRET` through a coordinated deployment.
- Do not accept a token merely because its payload looks plausible; the
  signature and claims are mandatory.

## Secrets and local development

Never hardcode secrets or tokens. In deployed Workers, store sensitive values
with `wrangler secret put` and declare required secret names in the Wrangler
configuration's `secrets.required` list. For local development, use a
`.dev.vars` file in the same directory as the Wrangler configuration. Both
`.dev.vars*` and `.env*` are gitignored in this repository.

Non-sensitive values such as `JWT_ISSUER` and `JWT_AUDIENCE` may be plain
Worker variables.

For local development, copy `.dev.vars.example` to `.dev.vars`, replace the
placeholder secret, and mint a short-lived token:

```bash
npm run migrate:local
npm run seed:local
npm run token:dev -- --role catalog_admin --sub ins_01J9ZK5A1B2C3D4E5F6G7H8J01
```

Use the printed token as `Authorization: Bearer <token>`. The minting script is
development-only and reads `.dev.vars` or the process environment; it never
contains a default secret.

The webhook signing secret is generated per subscription and is returned only
once at subscription creation; see [webhooks.md](./webhooks.md).
