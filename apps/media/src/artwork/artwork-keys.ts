import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";

import { ArtworkKey } from "@media/contracts/artwork";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";

import * as MediaConfig from "../media-config.ts";

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

/** Builds the codec from the raw bytes of `PLAYBACK_TOKEN_SECRET`. */
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

/** The codec keyed by `PLAYBACK_TOKEN_SECRET`, which the token verifier has already validated. */
export const layer: Layer.Layer<Service, never, MediaConfig.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return Service.of(make(Buffer.from(Redacted.value(config.playbackTokenSecret), "base64url")));
  }),
);
