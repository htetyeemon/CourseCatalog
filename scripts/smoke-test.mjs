#!/usr/bin/env node
/**
 * Smoke test: end-to-end publish flow against a deployed environment.
 *
 *  1. GET /v1/health (public)
 *  2. Pick an instructor (publishing requires at least one)
 *  3. POST /v1/courses (draft)
 *  4. If WEBHOOK_RECEIVER_URL is set, ensure a subscription for it exists
 *  5. POST /v1/courses/{id}/publish and verify the course is published
 *  6. If a receiver URL was given, wait for the delivery record to appear
 *
 * Environment variables:
 *   BASE_URL              Deployed API base URL (required),
 *                         e.g. https://course-catalog-staging.<subdomain>.workers.dev
 *   JWT_SECRET            HS256 secret of that environment, used to mint a
 *                         catalog_admin token (required)
 *   JWT_ISSUER            Issuer (default: https://auth.course-catalog.dev)
 *   JWT_AUDIENCE          Audience (default: catalog-api)
 *   INSTRUCTOR_ID         Instructor to attach to the course
 *                         (default: first instructor returned by the API)
 *   WEBHOOK_RECEIVER_URL  Public HTTPS endpoint that accepts course.published
 *                         webhooks (optional)
 *   PRINT_SIGNING_SECRET  Set to 1 to print a newly created subscription's signing secret
 *
 * Usage:
 *   BASE_URL=https://... JWT_SECRET=... node scripts/smoke-test.mjs
 *
 * Each run creates one draft course (code SMOKE-<4 digits>) and publishes it.
 */

import { createHmac, randomUUID } from "node:crypto";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER || "https://auth.course-catalog.dev";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "catalog-api";
const INSTRUCTOR_ID = process.env.INSTRUCTOR_ID || "";
const WEBHOOK_RECEIVER_URL = process.env.WEBHOOK_RECEIVER_URL || "";

if (!BASE_URL) {
  console.error(
    "ERROR: BASE_URL is required, e.g. https://course-catalog-staging.<subdomain>.workers.dev",
  );
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error(
    "ERROR: JWT_SECRET is required. It must match the secret configured for the target environment.",
  );
  process.exit(1);
}

function b64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function mintToken(role) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64Url(
    JSON.stringify({
      sub: `svc_smoke${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      role,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      iat: now,
      exp: now + 600,
    }),
  );
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const authHeader = `Bearer ${mintToken("catalog_admin")}`;

async function fetchApi(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      ...init.headers,
    },
  });
  const body = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();
  return { status: res.status, body, headers: res.headers };
}

function fail(message, extra) {
  console.error(`   FAIL: ${message}`);
  if (extra !== undefined) {
    console.error(`   ${JSON.stringify(extra)}`);
  }
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const totalSteps = WEBHOOK_RECEIVER_URL ? 6 : 5;
  console.log("=== Course Catalog Smoke Test ===\n");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(
    `Webhook receiver: ${WEBHOOK_RECEIVER_URL || "(none; webhook delivery check skipped)"}\n`,
  );

  console.log(`[1/${totalSteps}] Health check...`);
  const health = await fetch(`${BASE_URL}/v1/health`);
  console.log(`   GET /v1/health -> ${health.status}`);
  if (health.status !== 200) fail("Health check failed", await health.text());
  console.log("   OK\n");

  console.log(`[2/${totalSteps}] Pick an instructor...`);
  let instructorId = INSTRUCTOR_ID;
  if (!instructorId) {
    const instructors = await fetchApi("/v1/instructors?limit=1");
    console.log(`   GET /v1/instructors -> ${instructors.status}`);
    if (instructors.status !== 200) {
      fail(
        "Could not list instructors (is JWT_SECRET the one configured for this environment?)",
        instructors.body,
      );
    }
    instructorId = instructors.body?.data?.[0]?.id;
    if (!instructorId) fail("No instructors found. Seed the database or set INSTRUCTOR_ID.");
  }
  console.log(`   Instructor: ${instructorId}\n`);

  console.log(`[3/${totalSteps}] Create draft course...`);
  // Course codes must match /^[A-Z]{2,8}-[0-9]{3,4}$/; retry on a code collision.
  let code = "";
  let createRes = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    code = `SMOKE-${String(1000 + Math.floor(Math.random() * 9000))}`;
    createRes = await fetchApi("/v1/courses", {
      method: "POST",
      body: JSON.stringify({
        code,
        title: "Smoke Test Course",
        description: "A course created by the smoke-test script to verify the publish flow.",
        credits: 3,
        level: "introductory",
        department: "Computer Science",
        instructorIds: [instructorId],
      }),
    });
    console.log(`   POST /v1/courses (${code}) -> ${createRes.status}`);
    if (createRes.status !== 409) break;
  }
  if (createRes.status !== 201) fail("Course creation failed", createRes.body);
  const courseId = createRes.body.data.id;
  console.log(`   Course: ${courseId} (${code})\n`);

  let subscriptionId = null;
  let verifyDelivery = Boolean(WEBHOOK_RECEIVER_URL);
  if (WEBHOOK_RECEIVER_URL) {
    console.log(`[4/${totalSteps}] Ensure webhook subscription...`);
    const subRes = await fetchApi("/v1/webhooks/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        url: WEBHOOK_RECEIVER_URL,
        events: ["course.published"],
        description: "smoke-test",
      }),
    });
    console.log(`   POST /v1/webhooks/subscriptions -> ${subRes.status}`);
    if (subRes.status === 201) {
      subscriptionId = subRes.body.data.id;
      console.log(`   Created ${subscriptionId}.`);
      if (process.env.PRINT_SIGNING_SECRET === "1") {
        console.log(`   Signing secret (shown once): ${subRes.body.data.signingSecret}`);
      } else {
        console.log("   Signing secret not printed (set PRINT_SIGNING_SECRET=1 to show it once).");
      }
      console.log("   The receiver cannot verify signatures until this secret is configured on it;");
      console.log("   delivery verification is skipped for this run. Re-run to verify delivery.");
      verifyDelivery = false;
    } else if (subRes.status === 409) {
      const list = await fetchApi("/v1/webhooks/subscriptions?limit=100");
      subscriptionId =
        list.body?.data?.find((s) => s.url === WEBHOOK_RECEIVER_URL && s.status === "active")
          ?.id ?? null;
      if (!subscriptionId) fail("Subscription exists but was not found in the list", list.body);
      console.log(`   Reusing existing subscription ${subscriptionId}`);
    } else {
      fail("Subscription creation failed", subRes.body);
    }
    console.log("");
  }

  const publishStep = WEBHOOK_RECEIVER_URL ? 5 : 4;
  console.log(`[${publishStep}/${totalSteps}] Publish course...`);
  const publishedAfter = Date.now();
  const publishRes = await fetchApi(`/v1/courses/${courseId}/publish`, { method: "POST" });
  console.log(`   POST /v1/courses/${courseId}/publish -> ${publishRes.status}`);
  if (publishRes.status !== 200) fail("Publish failed", publishRes.body);
  if (publishRes.body?.data?.status !== "published") {
    fail("Publish response does not report status=published", publishRes.body);
  }

  const verifyStep = WEBHOOK_RECEIVER_URL ? 5 : 5;
  console.log(`[${verifyStep}/${totalSteps}] Verify course is published...`);
  const getRes = await fetchApi(`/v1/courses/${courseId}`);
  console.log(`   GET /v1/courses/${courseId} -> ${getRes.status}`);
  if (getRes.status !== 200 || getRes.body?.data?.status !== "published") {
    fail("Course is not published after publish", getRes.body);
  }
  console.log("   Course status: published\n");

  if (verifyDelivery) {
    console.log("[6/6] Wait for webhook delivery record...");
    let delivery = null;
    for (let attempt = 0; attempt < 15 && !delivery; attempt += 1) {
      const deliveries = await fetchApi(
        `/v1/webhooks/deliveries?subscriptionId=${subscriptionId}&limit=20`,
      );
      if (deliveries.status !== 200) fail("Could not list deliveries", deliveries.body);
      delivery =
        deliveries.body.data.find((d) => Date.parse(d.createdAt) >= publishedAfter - 5000) ??
        null;
      if (!delivery) await sleep(2000);
    }
    if (!delivery) fail("No delivery record appeared for the subscription within 30 seconds");
    console.log(
      `   Delivery ${delivery.id}: status=${delivery.status} attempt=${delivery.attempt} responseStatus=${delivery.responseStatus ?? "n/a"}`,
    );
    if (delivery.status !== "delivered") {
      fail(
        `Delivery is '${delivery.status}'. The receiver must return 2xx after verifying the signature.`,
        delivery,
      );
    }
    console.log("   Webhook delivered\n");
  }

  console.log("=== Smoke test PASSED ===");
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
