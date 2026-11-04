/**
 * Signed media URLs. Convex signs, the media service verifies. Both sides build the message with
 * `signedMessage`, so the format lives in one place.
 */

export type SignedResource =
  | { readonly kind: "stream"; readonly trackId: string; readonly profile: string }
  | { readonly kind: "art"; readonly hash: string };

/** The exact bytes that get signed. */
export const signedMessage = (resource: SignedResource, expiresAt: number): string =>
  resource.kind === "stream"
    ? `stream:${resource.trackId}:${resource.profile}:${expiresAt}`
    : `art:${resource.hash}:${expiresAt}`;

const encoder = new TextEncoder();

const toBase64Url = (bytes: ArrayBuffer): string => {
  let binary = "";

  for (const byte of new Uint8Array(bytes)) binary += String.fromCodePoint(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);

/** HMAC-SHA256 of the resource and expiry, base64url without padding. */
export const signResource = async (
  secret: string,
  resource: SignedResource,
  expiresAt: number,
): Promise<string> => {
  const key = await importKey(secret);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedMessage(resource, expiresAt)),
  );

  return toBase64Url(signature);
};

/** Constant-time comparison of two strings. */
export const timingSafeEqual = (left: string, right: string): boolean => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
};

/** Checks a signature and its expiry. */
export const verifyResource = async (
  secret: string,
  resource: SignedResource,
  expiresAt: number,
  signature: string,
  now: number,
): Promise<boolean> => {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = await signResource(secret, resource, expiresAt);

  return timingSafeEqual(expected, signature);
};
