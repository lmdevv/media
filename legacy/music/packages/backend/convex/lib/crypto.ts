const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** SHA-256 of a string, lowercase hex. */
export const sha256Hex = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";

/** A random token from an unambiguous alphabet. */
export const randomToken = (length: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    alphabet.charAt(byte % alphabet.length),
  ).join("");
