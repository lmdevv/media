import { createHmac } from "node:crypto";

import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Match, Option, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";

import { PlaybackSessionId, UserId } from "@media/contracts/ids";
import { PlaybackSessionEnded } from "@media/contracts/media-playback";
import {
  PLAYBACK_TOKEN_TEST_VECTORS,
  type PlaybackTokenInvalid,
  PlaybackTokenSecretInvalid,
} from "@media/contracts/playback-token";

import * as ConvexSessionReports from "../convex/convex-session-reports.ts";
import * as TestConvex from "../testing/test-convex.ts";
import * as EndedSessions from "./ended-sessions.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as SessionReports from "./session-reports.ts";

const secretBytes = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);

const secret = Redacted.make(secretBytes.toString("base64url"));

const claims = {
  aud: "media",
  sub: "user_1",
  pid: "profile_1",
  fid: "file_1",
  sid: "session_1",
  iat: 1_000,
  exp: 21_601_000,
};

const sign = (payload: string, key: Buffer = secretBytes): string => {
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(`v1.${encoded}`).digest("base64url");

  return `v1.${encoded}.${signature}`;
};

const verify = (token: string, purposes = PlaybackToken.PLAY) =>
  Effect.gen(function* () {
    const verifier = yield* PlaybackToken.make(secret).pipe(Effect.orDie);

    return yield* verifier.verify(Redacted.make(token), purposes);
  });

const reasonOf = Match.type<PlaybackTokenInvalid | PlaybackSessionEnded>().pipe(
  Match.tagsExhaustive({
    PlaybackTokenInvalid: (error) => error.reason,
    PlaybackSessionEnded: () => "session-ended" as const,
  }),
);

const rejection = (token: string, purposes = PlaybackToken.PLAY) =>
  verify(token, purposes).pipe(Effect.flip, Effect.map(reasonOf));

layer(EndedSessions.layerNone)("PlaybackToken", (it) => {
  it.effect("accepts a token signed with the shared secret before it expires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000);
      const grant = yield* verify(sign(JSON.stringify(claims)));

      assert.deepStrictEqual(grant, {
        userId: "user_1",
        profileId: "profile_1",
        fileId: "file_1",
        sessionId: "session_1",
        purpose: "play",
        audience: "household",
        expiresAt: 21_601_000,
      });
    }),
  );

  it.effect("keeps streaming and downloading tokens to their own routes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000);
      const playing = sign(JSON.stringify(claims));
      const downloading = sign(JSON.stringify({ ...claims, pur: "download" }));

      assert.strictEqual(yield* rejection(downloading, PlaybackToken.PLAY), "wrong_purpose");
      assert.strictEqual(yield* rejection(playing, PlaybackToken.DOWNLOAD), "wrong_purpose");
      assert.strictEqual((yield* verify(downloading, PlaybackToken.DOWNLOAD)).purpose, "download");
      assert.deepStrictEqual(
        [
          (yield* verify(playing, PlaybackToken.PLAY_OR_DOWNLOAD)).purpose,
          (yield* verify(downloading, PlaybackToken.PLAY_OR_DOWNLOAD)).purpose,
        ],
        ["play", "download"],
      );
    }),
  );

  it.effect("matches a fixed test vector", () =>
    Effect.gen(function* () {
      const token =
        "v1.eyJhdWQiOiJtZWRpYSIsInN1YiI6InVzZXJfMSIsInBpZCI6InByb2ZpbGVfMSIsImZpZCI6ImZpbGVfMSIsInNpZCI6InNlc3Npb25fMSIsImlhdCI6MTAwMCwiZXhwIjoyMTYwMTAwMH0." +
        sign(JSON.stringify(claims)).split(".")[2];

      assert.strictEqual(token, sign(JSON.stringify(claims)));
      yield* TestClock.setTime(5_000);
      const grant = yield* verify(token);

      assert.strictEqual(grant.fileId, "file_1");
    }),
  );

  it.effect("rejects a token at or after its expiry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(claims.exp);

      assert.strictEqual(yield* rejection(sign(JSON.stringify(claims))), "expired");
    }),
  );

  it.effect("refuses an expired token without asking about its session", () =>
    Effect.gen(function* () {
      const asked: Array<string> = [];

      const reports = Layer.succeed(
        SessionReports.Service,
        SessionReports.Service.of({
          follow: (followed) => {
            asked.push(followed);

            return Stream.never;
          },
        }),
      );

      const context = yield* Layer.build(EndedSessions.layer.pipe(Layer.provide(reports)));

      yield* TestClock.setTime(claims.exp);

      const refusal = yield* verify(sign(JSON.stringify(claims))).pipe(
        Effect.provide(context),
        Effect.flip,
        Effect.map(reasonOf),
      );

      assert.strictEqual(refusal, "expired");
      assert.deepStrictEqual(asked, []);
    }),
  );

  it.effect("rejects another audience", () =>
    Effect.gen(function* () {
      const token = sign(JSON.stringify({ ...claims, aud: "convex" }));

      assert.strictEqual(yield* rejection(token), "wrong_audience");
    }),
  );

  it.effect("rejects a signature made with another key", () =>
    Effect.gen(function* () {
      const token = sign(JSON.stringify(claims), Buffer.alloc(32, 7));

      assert.strictEqual(yield* rejection(token), "bad_signature");
    }),
  );

  it.effect("rejects a payload altered after signing", () =>
    Effect.gen(function* () {
      const [version, , signature] = sign(JSON.stringify(claims)).split(".");

      const forged = Buffer.from(JSON.stringify({ ...claims, fid: "file_2" })).toString(
        "base64url",
      );

      assert.strictEqual(yield* rejection(`${version}.${forged}.${signature}`), "bad_signature");
    }),
  );

  it.effect("rejects a non-canonical signature encoding", () =>
    Effect.gen(function* () {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const token = sign(JSON.stringify(claims));
      const signature = token.split(".")[2] ?? "";
      // The last character of a 32-byte signature carries two padding bits; flipping one aliases the bytes.
      const flipped = alphabet[alphabet.indexOf(signature.at(-1) ?? "A") ^ 1] ?? "";
      const alias = `${signature.slice(0, -1)}${flipped}`;

      assert.deepStrictEqual(Buffer.from(alias, "base64url"), Buffer.from(signature, "base64url"));
      yield* TestClock.setTime(5_000);

      assert.strictEqual(
        yield* rejection(`${token.slice(0, -signature.length)}${alias}`),
        "malformed",
      );
    }),
  );

  it.effect("rejects malformed tokens", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* rejection("v2.a.b"), "malformed");
      assert.strictEqual(yield* rejection("v1.only-two"), "malformed");
      assert.strictEqual(yield* rejection("v1.a+b.c"), "malformed");
      assert.strictEqual(yield* rejection(sign("not json")), "malformed");
      assert.strictEqual(yield* rejection(sign(JSON.stringify({ aud: "media" }))), "malformed");
    }),
  );

  it.effect("refuses a secret shorter than 32 bytes", () =>
    Effect.gen(function* () {
      const error = yield* PlaybackToken.make(
        Redacted.make(Buffer.alloc(16).toString("base64url")),
      ).pipe(Effect.flip);

      assert.instanceOf(error, PlaybackTokenSecretInvalid);
    }),
  );

  it.effect("agrees with the shared contract test vectors", () =>
    Effect.gen(function* () {
      const vectors = PLAYBACK_TOKEN_TEST_VECTORS;
      const verifier = yield* PlaybackToken.make(Redacted.make(vectors.secret)).pipe(Effect.orDie);

      yield* TestClock.setTime(vectors.valid.verifyAt);
      const grant = yield* verifier.verify(Redacted.make(vectors.valid.token), PlaybackToken.PLAY);

      assert.deepStrictEqual(
        [
          String(grant.userId),
          String(grant.profileId),
          String(grant.fileId),
          String(grant.sessionId),
          grant.expiresAt,
        ],
        [
          vectors.valid.payload.sub,
          vectors.valid.payload.pid,
          vectors.valid.payload.fid,
          vectors.valid.payload.sid,
          vectors.valid.payload.exp,
        ],
      );

      yield* TestClock.setTime(vectors.download.verifyAt);

      const download = yield* verifier.verify(
        Redacted.make(vectors.download.token),
        PlaybackToken.DOWNLOAD,
      );

      assert.strictEqual(download.purpose, "download");

      for (const rejected of vectors.rejected) {
        yield* TestClock.setTime(rejected.verifyAt);

        const error = yield* verifier
          .verify(Redacted.make(rejected.token), PlaybackToken.PLAY_OR_DOWNLOAD)
          .pipe(Effect.flip);

        assert.strictEqual(reasonOf(error), rejected.reason, rejected.description);
      }
    }),
  );
});

layer(
  EndedSessions.layer.pipe(
    Layer.provide(ConvexSessionReports.layer),
    Layer.provideMerge(TestConvex.layer),
  ),
)("PlaybackToken with Convex", (it) => {
  it.effect("refuses a valid token once its playback session ended", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000);
      const convex = yield* TestConvex.Service;
      const verifier = yield* PlaybackToken.make(secret).pipe(Effect.orDie);
      const sessionId = PlaybackSessionId.make(`session-${crypto.randomUUID()}`);
      const token = Redacted.make(sign(JSON.stringify({ ...claims, sid: sessionId })));

      yield* convex.report(sessionId, "playing", 0);

      assert.strictEqual((yield* verifier.verify(token, PlaybackToken.PLAY)).sessionId, sessionId);
      yield* convex.end(sessionId);

      const error = yield* verifier.verify(token, PlaybackToken.PLAY).pipe(Effect.flip);

      assert.deepStrictEqual(error, new PlaybackSessionEnded({ sessionId }));
    }),
  );

  it.effect("names the session of an authentic token it refuses, an ended one first", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000);
      const verifier = yield* PlaybackToken.make(secret).pipe(Effect.orDie);
      const convex = yield* TestConvex.Service;

      const sid = `session-${crypto.randomUUID()}`;

      yield* convex.report(sid, "playing", 0);

      const refusal = (token: string) =>
        verifier.authorize(Redacted.make(token), PlaybackToken.PLAY).pipe(
          Effect.flip,
          Effect.map((refused) => [
            reasonOf(refused.error),
            Option.getOrNull(refused.sessionForLog),
          ]),
        );

      const signed = {
        sessionId: PlaybackSessionId.make(sid),
        userId: UserId.make("user_1"),
      };

      const authentic = sign(JSON.stringify({ ...claims, sid }));
      const download = sign(JSON.stringify({ ...claims, sid, pur: "download" }));

      assert.deepStrictEqual(yield* refusal(download), ["wrong_purpose", signed]);

      yield* TestClock.setTime(claims.exp);

      assert.deepStrictEqual(yield* refusal(authentic), ["expired", signed]);
      assert.strictEqual(
        (yield* verifier.authorize(Redacted.make(authentic), PlaybackToken.PLAY).pipe(Effect.flip))
          .message,
        "Playback token has expired",
      );

      yield* convex.end(sid);

      assert.deepStrictEqual(yield* refusal(authentic), ["session-ended", signed]);
      assert.strictEqual(yield* rejection(authentic), "session-ended");

      for (const [forged, reason] of [
        [sign(JSON.stringify(claims), Buffer.alloc(32, 7)), "bad_signature"],
        [sign(JSON.stringify({ ...claims, aud: "convex" })), "wrong_audience"],
        [sign(JSON.stringify({ aud: "media" })), "malformed"],
        ["v1.forged.token", "malformed"],
      ] as const) {
        assert.deepStrictEqual(yield* refusal(forged), [reason, null]);
      }
    }),
  );
});
