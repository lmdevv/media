/**
 * Test grants for the byte routes, and artwork keys, under one test secret. Kept apart from
 * `test-config.ts`, which plain Node loads in the tool lifetime suite's child processes and so
 * imports no workspace package's sources.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { MediaFileId, PlaybackSessionId, ProfileId, UserId } from "@media/contracts/ids";
import { PlaybackSessionEnded, PlaybackTokenInvalid } from "@media/contracts/media-playback";
import { EpochMillis } from "@media/contracts/units";
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";

const testSecretBytes = Buffer.alloc(32, 9);

/** Claims of a test playback token; times are milliseconds since the epoch. */
export interface TestTokenClaims {
  readonly fid: string;
  readonly sid?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly pur?: "download";
}

/** Signs a test playback token with Node's HMAC and the test secret. */
export const signTestToken = (claims: TestTokenClaims): string => {
  const signed = {
    aud: claims.aud ?? "media",
    sub: "user_test",
    pid: "profile_test",
    fid: claims.fid,
    sid: claims.sid ?? "session_test",
    iat: Date.now(),
    exp: claims.exp ?? Date.now() + 6 * 60 * 60 * 1000,
  };

  const payload = Buffer.from(
    JSON.stringify(claims.pur === undefined ? signed : Object.assign(signed, { pur: claims.pur })),
  ).toString("base64url");

  return `v1.${payload}.${signatureOf(`v1.${payload}`)}`;
};

const signatureOf = (signed: string): string =>
  createHmac("sha256", testSecretBytes).update(signed).digest("base64url");

const TestClaims = Schema.fromJsonString(
  Schema.Struct({
    aud: Schema.String,
    sub: UserId,
    pid: ProfileId,
    fid: MediaFileId,
    sid: PlaybackSessionId,
    iat: EpochMillis,
    exp: EpochMillis,
    pur: Schema.optionalKey(Schema.Literal("download")),
  }),
);

type TestClaimsPayload = typeof TestClaims.Type;

const decodeClaims = Schema.decodeUnknownEffect(TestClaims);

const invalid = (reason: PlaybackTokenInvalid["reason"], message: string) =>
  new PlaybackTokenInvalid({ reason, message });

/** The claims of a test token whatever its expiry, once its signature and audience check out. */
const readIgnoringExpiry = Effect.fnUntraced(function* (token: string) {
  const [version, body, signature, ...rest] = token.split(".");

  if (version !== "v1" || body === undefined || signature === undefined || rest.length > 0) {
    return yield* invalid("malformed", "Playback token is malformed");
  }

  const expected = Buffer.from(signatureOf(`${version}.${body}`));
  const presented = Buffer.from(signature);

  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return yield* invalid("bad_signature", "Playback token signature does not match");
  }

  const claims = yield* decodeClaims(Buffer.from(body, "base64url").toString("utf8")).pipe(
    Effect.mapError(() => invalid("malformed", "Playback token payload has the wrong fields")),
  );

  if (claims.aud !== "media") {
    return yield* invalid("wrong_audience", "Playback token is for another audience");
  }

  return claims;
});

const checkExpiry = Effect.fnUntraced(function* (claims: TestClaimsPayload) {
  if (claims.exp <= (yield* Clock.currentTimeMillis)) {
    return yield* invalid("expired", "Playback token has expired");
  }

  return claims;
});

const TOKEN_PARAM = "token";

/**
 * The byte routes' grants over test tokens (`signTestToken`): HMAC-signed claims that name a file,
 * a session, a purpose, and an expiry, checked the way the routes' grant interface promises, with
 * `EndedSessions` saying which sessions ended. Unit tests drive the routes through it; the core's
 * tickets have their own tests (`core-tickets*.test.ts`).
 */
export const testTokensLayer: Layer.Layer<PlaybackToken.Service, never, EndedSessions.Service> =
  Layer.effect(
    PlaybackToken.Service,
    Effect.gen(function* () {
      const ended = yield* EndedSessions.Service;

      const grantOf = Effect.fnUntraced(function* (
        signed: TestClaimsPayload,
        purposes: ReadonlyArray<PlaybackToken.TokenPurpose>,
      ) {
        const payload = yield* checkExpiry(signed);
        const purpose = payload.pur ?? "play";

        if (!purposes.includes(purpose)) {
          return yield* new PlaybackTokenInvalid({
            reason: "wrong_purpose",
            message:
              purpose === "download"
                ? "A download token cannot stream"
                : "A playback token cannot download",
          });
        }

        return {
          userId: payload.sub,
          profileId: payload.pid,
          fileId: payload.fid,
          sessionId: payload.sid,
          purpose,
          audience: "household",
          expiresAt: payload.exp,
        } satisfies PlaybackToken.PlaybackGrant;
      });

      const authorize = Effect.fn("TestTokens.authorize")(function* (
        token: Redacted.Redacted,
        purposes: ReadonlyArray<PlaybackToken.TokenPurpose>,
      ) {
        const payload = yield* readIgnoringExpiry(Redacted.value(token)).pipe(
          Effect.mapError(
            (error) => new PlaybackToken.TokenRefused({ error, sessionForLog: Option.none() }),
          ),
        );

        const refuse = (error: PlaybackTokenInvalid | PlaybackSessionEnded) =>
          new PlaybackToken.TokenRefused({
            error,
            sessionForLog: Option.some({ sessionId: payload.sid, userId: payload.sub }),
          });

        const expired = yield* Effect.isFailure(checkExpiry(payload));

        if (yield* (expired ? ended.isKnownEnded : ended.isEnded)(payload.sid)) {
          return yield* refuse(new PlaybackSessionEnded({ sessionId: payload.sid }));
        }

        return yield* grantOf(payload, purposes).pipe(Effect.mapError(refuse));
      });

      return PlaybackToken.Service.of({
        param: TOKEN_PARAM,
        withToken: (url, token) =>
          `${url}?${TOKEN_PARAM}=${encodeURIComponent(Redacted.value(token))}`,
        authorize,
        verify: (token, purposes) =>
          authorize(token, purposes).pipe(Effect.mapError((refused) => refused.error)),
        verifyReport: (token) =>
          Effect.flatMap(readIgnoringExpiry(Redacted.value(token)), (payload) =>
            grantOf(payload, PlaybackToken.PLAY),
          ),
      });
    }),
  );

/** Artwork keys sealed under the test secret, the same in every test. */
export const testArtworkKeysLayer: Layer.Layer<ArtworkKeys.Service> = Layer.succeed(
  ArtworkKeys.Service,
  ArtworkKeys.Service.of(ArtworkKeys.make(testSecretBytes)),
);
