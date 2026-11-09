# Authentication and Authorization

The Course Catalog API uses Bearer JWTs. Every operation except
`GET /v1/health` requires an `Authorization` header:

```http
Authorization: Bearer <jwt>
```

The API does not accept tokens in query strings, cookies, or request bodies.
Tokens must be short-lived and must never be logged or committed to source
control.

## Token profile

Tokens are compact-serialized JWTs signed by the catalog identity provider.
The signing algorithm must be asymmetric (`RS256` or `ES256` are the supported
algorithms). Symmetric algorithms (`HS*`) and `alg: none` are rejected.

### Required claims

| Claim | Type | Description |
| --- | --- | --- |
| `sub` | string | Stable subject identifier. Students use their `stu_` ID, instructors use their `ins_` ID, and service tokens use a stable service principal identifier. |
| `role` | string | One of `student`, `instructor`, `catalog_admin`, or `service`. |
| `iss` | string | Issuer. Must equal `https://auth.course-catalog.dev`. |
| `exp` | integer | Expiry time as Unix seconds. |

Optional claims:

| Claim | Type | Description |
| --- | --- | --- |
| `iat` | integer | Issued-at time as Unix seconds. |
| `nbf` | integer | Not-before time as Unix seconds. |
| `jti` | string | Unique token identifier, useful for audit and revocation. |
| `aud` | string or string array | Audience. If present, it must include `catalog-api`. |

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

### Issuer and key discovery

- Issuer: `https://auth.course-catalog.dev`
- JWKS endpoint: `https://auth.course-catalog.dev/.well-known/jwks.json`
- API audience: `catalog-api`

The JWKS endpoint publishes the current verification keys. Consumers must
select a key by the JWT header's `kid`, cache the JWKS response, and refresh it
when an unknown `kid` is encountered. Cache the JWKS for a short TTL (for
example, one hour) and rate-limit forced refreshes.

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
| `checkPrerequisiteEligibility` | `POST /v1/courses/{courseId}/eligibility-check` | `student`, `instructor`, `catalog_admin`, `service` |
| `createWebhookSubscription` | `POST /v1/webhooks/subscriptions` | `catalog_admin`, `service` |
| `listWebhookDeliveries` | `GET /v1/webhooks/deliveries` | `catalog_admin`, `service` |
| `getHealth` | `GET /v1/health` | Public |

Additional subject-level rule: a caller with role `student` may only check
eligibility for the `studentId` that matches its `sub` claim. Other roles may
check any student.

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

Check eligibility as a student:

```bash
curl -s -X POST "https://api.course-catalog.dev/v1/courses/crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2D/eligibility-check" \
  -H "Authorization: Bearer $CATALOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"studentId": "stu_01J9ZK6B2C3D4E5F6G7H8J9K0M"}'
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

The analysis below uses the Workers runtime's built-in Web Crypto API, which
supports RSA, ECDSA, and Ed25519 verification. You can also use a maintained
JWT/JWKS library, provided it enforces the same checks.

1. Read the `Authorization` header. Require the `Bearer` scheme and a
   non-empty token.
2. Split the compact JWT into header, payload, and signature segments. Reject
   malformed tokens.
3. Decode the header and payload as JSON. Do not trust either until the
   signature is verified.
4. Reject `alg` values outside the `RS256`/`ES256` allowlist and reject tokens
   without a `kid`.
5. Load the JWKS, select the key matching `kid`, and verify the signature with
   `crypto.subtle.verify`.
6. Validate `iss` exactly. Reject a missing or mismatched issuer.
7. Validate `exp` against the current Unix time with a small clock skew
   allowance (60 seconds is recommended). If `nbf` is present, validate it with
   the same allowance. If `aud` is present, require `catalog-api`.
8. Validate that `role` is a known role and is allowed for the operation.
9. Attach an internal auth context such as `{ sub, role }` to the request.
   Never pass the raw token to downstream services or logs.

Recommended token handling:

- Use HTTPS only.
- Keep access tokens short-lived.
- Cache JWKS responses; do not fetch them on every request.
- Refresh JWKS on an unknown `kid`, with a rate limit to prevent abuse.
- Reject tokens with duplicate or ambiguous header parameters.
- Do not accept a token merely because its payload looks plausible; the
  signature and claims are mandatory.

## Secrets and local development

Never hardcode secrets or tokens. In deployed Workers, store sensitive values
with `wrangler secret put` and declare required secret names in the Wrangler
configuration's `secrets.required` list. For local development, use a
`.dev.vars` file in the same directory as the Wrangler configuration. Both
`.dev.vars*` and `.env*` are gitignored in this repository.

Non-sensitive values such as `JWT_ISSUER`, `JWKS_URL`, and `JWT_AUDIENCE` may
be plain Worker variables. The webhook signing secret is generated per
subscription and is returned only once at subscription creation; see
[webhooks.md](./webhooks.md).
