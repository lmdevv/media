/**
 * Test grants for the byte routes, and artwork keys, under one test secret. Kept apart from
 * `test-config.ts`, which plain Node loads in the tool lifetime suite's child processes and so
 * imports no workspace package's sources.
 */
import { createHmac } from "node:crypto";

import { PlaybackSessionEnded } from "@media/contracts/media-playback";
import {
  checkPlaybackTokenExpiry,
  importPlaybackTokenSecret,
  PlaybackTokenInvalid,
  type PlaybackTokenPayload,
  readPlaybackTokenIgnoringExpiry,
} from "@media/contracts/playback-token";
import { Effect, Layer, Option, Redacted } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackToken from "../playback/playback-token.ts";

const testSecretBytes = Buffer.alloc(32, 9);

/** Claims of a test playback token; times are milliseconds since the epoch. */
export interface TestTokenClaims {
  readonly fid: string;
  readonly sid?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly pur?: "download";
}

/** Signs a playback token the way Convex does, with Node's HMAC and the test secret. */
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

  const signature = createHmac("sha256", testSecretBytes)
    .update(`v1.${payload}`)
    .digest("base64url");

  return `v1.${payload}.${signature}`;
};

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
      const key = yield* importPlaybackTokenSecret(
        Redacted.make(testSecretBytes.toString("base64url")),
      ).pipe(Effect.orDie);

      const ended = yield* EndedSessions.Service;

      const grantOf = Effect.fnUntraced(function* (
        signed: PlaybackTokenPayload,
        purposes: ReadonlyArray<PlaybackToken.TokenPurpose>,
      ) {
        const payload = yield* checkPlaybackTokenExpiry(signed);
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
        const payload = yield* readPlaybackTokenIgnoringExpiry(key, Redacted.value(token)).pipe(
          Effect.mapError(
            (error) => new PlaybackToken.TokenRefused({ error, sessionForLog: Option.none() }),
          ),
        );

        const refuse = (error: PlaybackTokenInvalid | PlaybackSessionEnded) =>
          new PlaybackToken.TokenRefused({
            error,
            sessionForLog: Option.some({ sessionId: payload.sid, userId: payload.sub }),
          });

        const expired = yield* Effect.isFailure(checkPlaybackTokenExpiry(payload));

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
          Effect.flatMap(readPlaybackTokenIgnoringExpiry(key, Redacted.value(token)), (payload) =>
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
