import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { ArtworkKey } from "@media/contracts/artwork";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";

/** Where an artwork image lives. */
export type ArtworkSource = Data.TaggedEnum<{
  /** An image file; the absolute path inside a library folder. */
  Local: { readonly path: string };
  /** An image at a metadata provider, such as a TMDB poster URL. */
  Remote: { readonly url: string };
}>;

/** Constructors and matchers for `ArtworkSource`. */
export const ArtworkSource = Data.taggedEnum<ArtworkSource>();

/** Seals and opens artwork keys. */
export interface Interface {
  readonly seal: (source: ArtworkSource) => Effect.Effect<ArtworkKey>;
  /** The source sealed in `key`; none for a key this service did not seal. */
  readonly open: (key: string) => Effect.Effect<Option.Option<ArtworkSource>>;
}

/** The artwork key codec. */
export class Service extends Context.Service<Service, Interface>()("@media/server/ArtworkKeys") {}

const PREFIX = "a1.";

const IV_BYTES = 12;

const TAG_BYTES = 16;

const SealedSource = Schema.Union([
  Schema.Struct({ l: Schema.String }),
  Schema.Struct({ r: Schema.String }),
]);

const decodeSealed = Schema.decodeUnknownOption(Schema.fromJsonString(SealedSource));

const derive = (secret: Buffer, label: string): Buffer =>
  createHmac("sha256", secret).update(label, "utf8").digest();

/** Builds the codec from the bytes of a secret only this server holds. */
export const make = (secret: Buffer): Interface => {
  const encryptionKey = derive(secret, "movies artwork key v1");
  const ivKey = derive(secret, "movies artwork iv v1");

  const seal = (source: ArtworkSource): ArtworkKey => {
    const plaintext = Buffer.from(
      JSON.stringify(
        ArtworkSource.$match(source, {
          Local: ({ path }) => ({ l: path }),
          Remote: ({ url }) => ({ r: url }),
        }),
      ),
      "utf8",
    );

    const iv = createHmac("sha256", ivKey).update(plaintext).digest().subarray(0, IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);

    const sealed = Buffer.concat([
      iv,
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    return ArtworkKey.make(`${PREFIX}${sealed.toString("base64url")}`);
  };

  const open = (key: string): Option.Option<ArtworkSource> => {
    if (!key.startsWith(PREFIX)) return Option.none();
    const sealed = Buffer.from(key.slice(PREFIX.length), "base64url");

    if (sealed.length <= IV_BYTES + TAG_BYTES) return Option.none();

    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      sealed.subarray(0, IV_BYTES),
    ).setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));

    const plaintext = Option.liftThrowable(() =>
      Buffer.concat([
        decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8"),
    )();

    return Option.flatMap(plaintext, decodeSealed).pipe(
      Option.map((value) =>
        "l" in value
          ? ArtworkSource.Local({ path: value.l })
          : ArtworkSource.Remote({ url: value.r }),
      ),
    );
  };

  return {
    seal: (source) => Effect.sync(() => seal(source)),
    open: (key) => Effect.sync(() => open(key)),
  };
};

/**
 * The codec keyed by `secret`. On the core that is the server's own service key, which the core
 * stores only as a hash, as the importer seals source credentials, so the core and its backups
 * hold keys that only this server opens. A new service key makes earlier artwork keys unreadable
 * until a rescan and a metadata refresh write new ones.
 */
export const layerKeyed = (secret: Redacted.Redacted): Layer.Layer<Service> =>
  Layer.succeed(Service, Service.of(make(Buffer.from(Redacted.value(secret), "utf8"))));

/**
 * The codec keyed by a secret drawn when the layer is built, for standalone mode, whose library
 * lives only in memory and so never outlives its keys.
 */
export const layerEphemeral: Layer.Layer<Service> = Layer.sync(Service, () =>
  Service.of(make(randomBytes(32))),
);
