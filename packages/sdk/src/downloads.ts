import {
  type ClientCapabilities,
  type DownloadQuality,
  MEDIA_ROUTES,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
} from "@media/contracts/media-playback";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { Effect, Option, Redacted } from "effect";

import { encodeJson, mediaUrl, requestPlayback } from "./media-http";

/**
 * Where the session's download stands: `Preparing` with its progress, or `Ready` with the URL to
 * fetch, its size, and its text subtitles. Asking starts the media service's work when needed.
 */
export const prepare = Effect.fn("Downloads.prepare")(function* (
  started: StartedPlayback,
  capabilities: ClientCapabilities,
  quality: DownloadQuality,
  audioStreamIndex: Option.Option<number>,
) {
  return yield* requestPlayback(
    {
      operation: "downloads.prepare",
      url: yield* mediaUrl(started, MEDIA_ROUTES.prepareDownload),
      method: "POST",
      body: Option.some(
        yield* encodeJson(PrepareDownloadRequest, {
          token: Redacted.make(started.token),
          capabilities,
          quality,
          ...Option.match(audioStreamIndex, {
            onNone: () => ({}),
            onSome: (index) => ({ audioStreamIndex: index }),
          }),
        }),
      ),
      bearer: Option.none(),
    },
    PrepareDownloadResponse,
  );
});
