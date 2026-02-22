/**
 * Verify Instagram/Meta webhook signature using raw bytes
 * Uses HMAC-SHA256 with the app secret
 */
export async function verifyWebhookSignatureBytes(
  payload: Uint8Array,
  signature: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signature) {
    return false;
  }

  // Signature format: "sha256=<hash>"
  const expectedPrefix = "sha256=";
  if (!signature.startsWith(expectedPrefix)) {
    return false;
  }

  const providedHash = signature.slice(expectedPrefix.length);

  // Compute HMAC-SHA256
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);

  // Convert to hex string
  const computedHash = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  return secureCompare(computedHash, providedHash);
}

/**
 * Verify HubSpot webhook signature (v2)
 * Hash = SHA-256(clientSecret + httpMethod + httpUrl + requestBody)
 */
export async function verifyHubSpotSignature(
  httpMethod: string,
  httpUrl: string,
  rawBody: string,
  signature: string | null,
  clientSecret: string
): Promise<boolean> {
  if (!signature) {
    return false;
  }

  const sourceString = clientSecret + httpMethod + httpUrl + rawBody;

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(sourceString)
  );

  const computedHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return secureCompare(computedHash, signature);
}

/**
 * Verify HubSpot webhook signature (v3)
 * HMAC-SHA256(clientSecret, requestMethod + requestUri + requestBody + timestamp)
 * Result is base64-encoded
 */
export async function verifyHubSpotSignatureV3(
  httpMethod: string,
  httpUrl: string,
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  clientSecret: string
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  // Reject if timestamp is older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (Date.now() - ts > 300_000) {
    return false;
  }

  const sourceString = httpMethod + httpUrl + rawBody + timestamp;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sourceString)
  );

  const computedHash = btoa(
    String.fromCharCode(...new Uint8Array(signatureBuffer))
  );

  return secureCompare(computedHash, signature);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
