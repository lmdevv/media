/**
 * The playback token of a media request. `<video>`, HLS segment, and `<img>` requests cannot set
 * headers, so every token-authorized route reads it from a query parameter, kept redacted:
 * `token` for old movies' tokens, `ticket` for core tickets.
 */
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { Effect, Redacted } from "effect";
import type { HttpServerRequest } from "effect/http";

/** The `param` query parameter, or `PlaybackTokenInvalid` when it is missing. */
export const playbackTokenOf = (request: HttpServerRequest.HttpServerRequest, param: string) => {
  const token = new URL(request.url, "http://media.invalid").searchParams.get(param);

  return token === null || token === ""
    ? Effect.fail(
        new PlaybackTokenInvalid({ reason: "malformed", message: "Playback token is missing" }),
      )
    : Effect.succeed(Redacted.make(token));
};
