import type { MediaFileId, PlaybackSessionId, ProfileId, UserId } from "@media/contracts/ids";
import {
  type PlaybackSessionEnded,
  PlaybackTokenInvalid,
  type StreamId,
} from "@media/contracts/media-playback";
import { TICKET_PARAM } from "@media/contracts/ticket";
import { Context, Data, Effect, Layer, Option, Redacted } from "effect";
import type { HttpServerRequest } from "effect/http";

import type { Audience } from "./encoder-slots.ts";

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
  /** A profile, which only the unit tests' tokens name; core tickets name none. */
  readonly profileId?: ProfileId;
  /**
   * What the ticket names: a movies file, or a music track, whose id `fileId` then holds. A route
   * serves only its own kind.
   */
  readonly resource: "file" | "track";
  readonly fileId: MediaFileId;
  readonly sessionId: PlaybackSessionId;
  readonly purpose: TokenPurpose;
  /** Who the stream plays for; every unit-test token is the household's. */
  readonly audience: Audience;
  /** Expiry in milliseconds since the epoch. */
  readonly expiresAt: number;
  /**
   * Completes once the session the grant was admitted for ends, for a byte response to stop
   * then (ADR 0011). Absent for the unit tests' tokens, whose responses run to their end.
   */
  readonly sessionEnded?: Effect.Effect<void>;
}

/**
 * Whether `grant` admits the movies file `fileId`: a file ticket for that file. A music track's
 * ticket never does, whatever its id.
 */
export const admitsFile = (grant: PlaybackGrant, fileId: string): boolean =>
  grant.resource === "file" && grant.fileId === fileId;

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

/** A request that reads the playback's file and starts no encoder. */
export const READ = "read";

/** What a request is beyond a start: inside a running stream, or a read (`READ`). */
export type Within = StreamId | typeof READ;

/** Checks playback tokens. */
export interface Interface {
  /** The query parameter tokens travel in on media URLs: `ticket` for core tickets. */
  readonly param: string;
  /** `url` with `token` in the query parameter it travels in. */
  readonly withToken: (url: string, token: Redacted.Redacted) => string;
  /**
   * The grant of a valid token for one of `purposes`. Fails with `PlaybackSessionEnded` once its
   * session ended, whatever else is wrong with an authentic token, though an expired one only
   * when the end is already known, and `PlaybackTokenInvalid` for a malformed, forged, expired, or
   * misaddressed token or one for another purpose.
   *
   * `within` says what the request is, for core tickets (ADR 0011); the unit tests' tokens ignore
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

/**
 * The token of a media request in the `param` query parameter, kept redacted, or
 * `PlaybackTokenInvalid` when it is missing. `<video>`, HLS segment, and `<img>` requests cannot
 * set headers, so every token-authorized route reads it from the URL.
 */
export const tokenOf = (request: HttpServerRequest.HttpServerRequest, param: string) => {
  const token = new URL(request.url, "http://media.invalid").searchParams.get(param);

  return token === null || token === ""
    ? Effect.fail(
        new PlaybackTokenInvalid({ reason: "malformed", message: "Playback token is missing" }),
      )
    : Effect.succeed(Redacted.make(token));
};

const NO_ISSUER = "This server runs without the core, which issues tickets";

const refused = new PlaybackTokenInvalid({ reason: "malformed", message: NO_ISSUER });

/**
 * Grants for standalone mode: with no core nothing issues tickets, so every byte route refuses.
 * Scanning and the health report still run.
 */
export const layerRefusing: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    param: TICKET_PARAM,
    withToken: (url, token) =>
      `${url}?${TICKET_PARAM}=${encodeURIComponent(Redacted.value(token))}`,
    verify: () => Effect.fail(refused),
    authorize: () =>
      Effect.fail(new TokenRefused({ error: refused, sessionForLog: Option.none() })),
    verifyReport: () => Effect.fail(refused),
  }),
);
