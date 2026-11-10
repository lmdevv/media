import type { MediaFileId, PlaybackSessionId, ProfileId, UserId } from "@media/contracts/ids";
import { PlaybackSessionEnded, type StreamId } from "@media/contracts/media-playback";
import {
  checkPlaybackTokenExpiry,
  importPlaybackTokenSecret,
  PlaybackTokenInvalid,
  type PlaybackTokenPayload,
  type PlaybackTokenSecretInvalid,
  readPlaybackTokenIgnoringExpiry,
} from "@media/contracts/playback-token";
import { Context, Data, Effect, Layer, Option, Redacted } from "effect";

import * as MediaConfig from "../media-config.ts";
import type { Audience } from "./encoder-slots.ts";
import * as EndedSessions from "./ended-sessions.ts";

/** What a token is for: streaming a file, or downloading it to keep on a device. */
export type TokenPurpose = "play" | "download";

/** Routes only streaming serves: negotiation, seeking, HLS, and trickplay. */
export const PLAY: ReadonlyArray<TokenPurpose> = ["play"];

/** Routes only downloads use: preparing a download and its prepared MP4. */
export const DOWNLOAD: ReadonlyArray<TokenPurpose> = ["download"];

/** Routes both use: the original file and its subtitles. */
export const PLAY_OR_DOWNLOAD: ReadonlyArray<TokenPurpose> = ["play", "download"];

/** What a verified token allows: one profile playing one file in one playback session. */
export interface PlaybackGrant {
  readonly userId: UserId;
  /** Old movies' profile; core tickets name no profile. */
  readonly profileId?: ProfileId;
  readonly fileId: MediaFileId;
  readonly sessionId: PlaybackSessionId;
  readonly purpose: TokenPurpose;
  /** Who the stream plays for; every old movies token is the household's. */
  readonly audience: Audience;
  /** Expiry in milliseconds since the epoch. */
  readonly expiresAt: number;
  /**
   * Completes once the session the grant was admitted for ends, for a byte response to stop
   * then (ADR 0011). Absent for old movies' tokens, whose responses run to their end.
   */
  readonly sessionEnded?: Effect.Effect<void>;
}

/** The session and account an authentic token was signed for. */
export type SignedSession = Pick<PlaybackGrant, "sessionId" | "userId">;

/** A refused token: the reason, and the session it was signed for when it is authentic. */
export class TokenRefused extends Data.TaggedError("TokenRefused")<{
  readonly error: PlaybackTokenInvalid | PlaybackSessionEnded;
  readonly sessionForLog: Option.Option<SignedSession>;
}> {
  override get message(): string {
    return this.error.message;
  }
}

/** Old movies' playback tokens travel in this query parameter. */
const TOKEN_PARAM = "token";

/** A request that reads the playback's file and starts no encoder. */
export const READ = "read";

/** What a request is beyond a start: inside a running stream, or a read (`READ`). */
export type Within = StreamId | typeof READ;

/** Checks playback tokens. */
export interface Interface {
  /** The query parameter tokens travel in on media URLs: `token`, or `ticket` for core tickets. */
  readonly param: string;
  /** `url` with `token` in the query parameter it travels in. */
  readonly withToken: (url: string, token: Redacted.Redacted) => string;
  /**
   * The grant of a valid token for one of `purposes`. Fails with `PlaybackSessionEnded` once its
   * session ended, whatever else is wrong with an authentic token, though an expired one only
   * when the end is already known, and `PlaybackTokenInvalid` for a malformed, forged, expired, or
   * misaddressed token or one for another purpose.
   *
   * `within` says what the request is, for core tickets (ADR 0011); old movies' tokens ignore
   * it. A stream's id: a request inside that running stream (its playlist, segments, seeks, and
   * stop), which continues the admission that started it past the ticket's expiry while its
   * session is live, and is refused for any other ticket. `READ`: a read of the playback's own
   * file that starts no encoder (direct play, subtitles, scrub thumbnails), which continues an
   * expired play ticket while its playback has an open stream or was used within
   * `STREAM_IDLE_SECONDS`. Absent: a start, which needs an unexpired ticket.
   */
  readonly verify: (
    token: Redacted.Redacted,
    purposes: ReadonlyArray<TokenPurpose>,
    within?: Within,
  ) => Effect.Effect<PlaybackGrant, PlaybackTokenInvalid | PlaybackSessionEnded>;
  /** `verify`, failing with the session an authentic token names alongside the reason. */
  readonly authorize: (
    token: Redacted.Redacted,
    purposes: ReadonlyArray<TokenPurpose>,
    within?: Within,
  ) => Effect.Effect<PlaybackGrant, TokenRefused>;
  /**
   * The grant of a valid streaming token, even once its session ended: a player's last reports
   * about a session arrive as it ends. Fails with `PlaybackTokenInvalid` like `verify`.
   */
  readonly verifyReport: (
    token: Redacted.Redacted,
  ) => Effect.Effect<PlaybackGrant, PlaybackTokenInvalid>;
}

/** The playback token verifier. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/PlaybackTokenVerifier",
) {}

/** Builds a verifier for tokens signed with `secret`. */
export const make = Effect.fn("PlaybackTokenVerifier.make")(function* (
  secret: Redacted.Redacted,
): Effect.fn.Return<Interface, PlaybackTokenSecretInvalid, EndedSessions.Service> {
  const key = yield* importPlaybackTokenSecret(secret);
  const ended = yield* EndedSessions.Service;

  const grantOf = Effect.fnUntraced(function* (
    signed: PlaybackTokenPayload,
    purposes: ReadonlyArray<TokenPurpose>,
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
    } satisfies PlaybackGrant;
  });

  const authorize = Effect.fn("PlaybackTokenVerifier.authorize")(function* (
    token: Redacted.Redacted,
    purposes: ReadonlyArray<TokenPurpose>,
  ) {
    const payload = yield* readPlaybackTokenIgnoringExpiry(key, Redacted.value(token)).pipe(
      Effect.mapError((error) => new TokenRefused({ error, sessionForLog: Option.none() })),
    );

    const refuse = (error: PlaybackTokenInvalid | PlaybackSessionEnded) =>
      new TokenRefused({
        error,
        sessionForLog: Option.some({ sessionId: payload.sid, userId: payload.sub }),
      });

    const expired = yield* Effect.isFailure(checkPlaybackTokenExpiry(payload));

    if (yield* (expired ? ended.isKnownEnded : ended.isEnded)(payload.sid)) {
      return yield* refuse(new PlaybackSessionEnded({ sessionId: payload.sid }));
    }

    return yield* grantOf(payload, purposes).pipe(Effect.mapError(refuse));
  });

  return Service.of({
    param: TOKEN_PARAM,
    withToken: (url, token) => `${url}?${TOKEN_PARAM}=${encodeURIComponent(Redacted.value(token))}`,
    authorize,
    verify: Effect.fn("PlaybackTokenVerifier.verify")(
      (token: Redacted.Redacted, purposes: ReadonlyArray<TokenPurpose>) =>
        authorize(token, purposes).pipe(Effect.mapError((refused) => refused.error)),
    ),
    verifyReport: Effect.fn("PlaybackTokenVerifier.verifyReport")((token: Redacted.Redacted) =>
      Effect.flatMap(readPlaybackTokenIgnoringExpiry(key, Redacted.value(token)), (payload) =>
        grantOf(payload, PLAY),
      ),
    ),
  });
});

/** Verifies tokens with `PLAYBACK_TOKEN_SECRET` from the media configuration. */
export const layer: Layer.Layer<
  Service,
  PlaybackTokenSecretInvalid,
  MediaConfig.Service | EndedSessions.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return yield* make(config.playbackTokenSecret);
  }),
);
