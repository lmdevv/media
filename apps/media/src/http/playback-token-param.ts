/**
 * The playback token of a media request. `<video>`, HLS segment, and `<img>` requests cannot set
 * headers, so every token-authorized route reads it from the `token` query parameter, kept
 * redacted.
 */
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { Effect, Redacted } from "effect";
import type { HttpServerRequest } from "effect/http";

/** The `token` query parameter, or `PlaybackTokenInvalid` when it is missing. */
export const playbackTokenOf = (request: HttpServerRequest.HttpServerRequest) => {
  const token = new URL(request.url, "http://media.invalid").searchParams.get("token");

  return token === null || token === ""
    ? Effect.fail(
        new PlaybackTokenInvalid({ reason: "malformed", message: "Playback token is missing" }),
      )
    : Effect.succeed(Redacted.make(token));
};
