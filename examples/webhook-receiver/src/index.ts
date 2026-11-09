import type { ExportedHandler } from "cloudflare:workers";

// Processed event IDs retained for replay/idempotency.
// In production, back this with KV or a Durable Object so IDs survive redeploys.
const processedEventIds = new Set<string>();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

async function verifyCatalogSignature(
  rawBody: string,
  signatureHeader: string,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = signatureHeader.split(",");
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signaturePart = parts.find((part) => part.startsWith("v1="));

  if (!timestampPart || !signaturePart) {
    return false;
  }

  const timestamp = Number(timestampPart.slice(2));
  const providedHex = signaturePart.slice(3);

  if (!Number.isInteger(timestamp)) {
    return false;
  }

  if (Math.abs(nowSeconds - timestamp) > 300) {
    return false;
  }

  if (!/^[a-f0-9]{64}$/.test(providedHex)) {
    return false;
  }

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

export default {
  async fetch(request: Request, env: { WEBHOOK_SIGNING_SECRET: string }): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const signature = request.headers.get("x-catalog-signature") ?? "";
    const eventId = request.headers.get("x-catalog-event-id") ?? "";
    const eventType = request.headers.get("x-catalog-event") ?? "";

    if (!signature || !eventId || !eventType) {
      return new Response("Missing required webhook headers.", { status: 400 });
    }

    // Reject duplicate event IDs (idempotency). Retries share the event ID.
    if (processedEventIds.has(eventId)) {
      return new Response("Already processed.", { status: 200 });
    }

    // Read the raw body once; verification operates on the exact bytes signed.
    const rawBody = await request.text();

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (!(await verifyCatalogSignature(rawBody, signature, env.WEBHOOK_SIGNING_SECRET, nowSeconds))) {
      return new Response("Invalid signature.", { status: 401 });
    }

    // Record the event ID before processing so duplicate deliveries are ignored.
    processedEventIds.add(eventId);

    let event: unknown;

    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON body.", { status: 400 });
    }

    // Handle the event idempotently. For course.published, persist the course
    // to your catalog using event.id as the idempotency key.
    console.log(`Received ${eventType} event ${eventId}`, event);

    // Return 2xx only after durable acceptance.
    return new Response("Accepted.", { status: 200 });
  },
} satisfies ExportedHandler;
