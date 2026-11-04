import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { MigrationCredentials } from "@media/contracts/models/migration";
import type { SealedCredentials } from "@media/contracts/models/migration-service";
import { Effect, Redacted, Schema } from "effect";

const SALT = "movies/migration-credentials";

const INFO = "v1";

const NONCE_BYTES = 12;

const TAG_BYTES = 16;

/** The sealed credentials cannot be opened: the service key changed, or the value was altered. */
export class CredentialsUnreadable extends Schema.TaggedError<CredentialsUnreadable>()(
  "CredentialsUnreadable",
  {},
) {
  override get message(): string {
    return "Source credentials unreadable: the media service key changed since the import started; start the import again";
  }
}

const CredentialsJson = Schema.fromJsonString(MigrationCredentials);

const encodeCredentials = Schema.encodeSync(CredentialsJson);

const decodeCredentials = Schema.decodeUnknownEffect(CredentialsJson);

const keyOf = (secret: Redacted.Redacted): Buffer =>
  Buffer.from(hkdfSync("sha256", Redacted.value(secret), SALT, INFO, 32));

const associatedData = (binding: string): Buffer => Buffer.from(binding, "utf8");

/** Seals `credentials` under `secret`, bound to `binding` (such as the server ID and URL). */
export const sealCredentials = (
  secret: Redacted.Redacted,
  credentials: MigrationCredentials,
  binding: string,
): SealedCredentials => {
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), nonce, {
    authTagLength: TAG_BYTES,
  });

  cipher.setAAD(associatedData(binding));

  const sealed = Buffer.concat([
    cipher.update(encodeCredentials(credentials), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return {
    version: 1,
    nonce: nonce.toString("base64url"),
    ciphertext: sealed.toString("base64url"),
  };
};

/** Opens credentials sealed by `sealCredentials` with the same secret and binding. */
export const openCredentials = (
  secret: Redacted.Redacted,
  sealed: SealedCredentials,
  binding: string,
): Effect.Effect<MigrationCredentials, CredentialsUnreadable> =>
  Effect.try({
    try: () => {
      const data = Buffer.from(sealed.ciphertext, "base64url");

      if (data.length <= TAG_BYTES) throw new Error("Sealed credentials are too short");

      // A fixed tag length: GCM would otherwise accept tags as short as 4 bytes.
      const decipher = createDecipheriv(
        "aes-256-gcm",
        keyOf(secret),
        Buffer.from(sealed.nonce, "base64url"),
        { authTagLength: TAG_BYTES },
      );

      decipher.setAAD(associatedData(binding));
      decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));

      return Buffer.concat([
        decipher.update(data.subarray(0, data.length - TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    },
    catch: () => new CredentialsUnreadable(),
  }).pipe(
    Effect.flatMap(decodeCredentials),
    Effect.mapError(() => new CredentialsUnreadable()),
  );
