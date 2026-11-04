const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** SHA-256 of a string as lowercase hex: how the core stores a secret. */
export const sha256Hex = async (value: string): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

/** `byteCount` random bytes as base64url without padding. Call it from an action. */
export const randomSecret = (byteCount: number): string => {
  const binary = Array.from(crypto.getRandomValues(new Uint8Array(byteCount)), (byte) =>
    String.fromCodePoint(byte),
  ).join("");

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

/** Compares two strings in time that depends only on their lengths. */
export const constantTimeEqual = (left: string, right: string): boolean => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
};

/** A secret that names its own row: `<prefix>_<rowId>.<secret>`. */
export const formatSecret = (prefix: string, rowId: string, secret: string): string =>
  `${prefix}_${rowId}.${secret}`;

/** The row id and secret of a `formatSecret` string, or null when it has another shape. */
export const parseSecret = (
  prefix: string,
  text: string,
): { readonly rowId: string; readonly secret: string } | null => {
  const match = new RegExp(`^${prefix}_([a-z0-9]+)\\.([\\w-]{20,})$`, "u").exec(text);
  const rowId = match?.[1];
  const secret = match?.[2];

  return rowId === undefined || secret === undefined ? null : { rowId, secret };
};
