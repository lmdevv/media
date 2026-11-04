import type { DeviceId, EpisodeId, MediaFileId, ProfileId, TitleId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  type DownloadQuality,
  MEDIA_ROUTES,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
} from "@media/contracts/media-playback";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { Effect, Option, Redacted } from "effect";

import { encodeJson, mediaUrl, requestPlayback, withRenewedToken } from "./media-http";
import { MoviesClient } from "./movies-client";

/** What to download: a movie, or an episode of a show, in a chosen version or the server's choice. */
export interface DownloadRequest {
  readonly profileId: ProfileId;
  readonly deviceId: DeviceId;
  readonly deviceName: Option.Option<string>;
  readonly titleId: TitleId;
  readonly episodeId: Option.Option<EpisodeId>;
  readonly fileId: Option.Option<MediaFileId>;
  readonly capabilities: ClientCapabilities;
}

/** Starts a download session, which leaves this device's playback alone. */
export const start = Effect.fn("Downloads.start")(function* (request: DownloadRequest) {
  const client = yield* MoviesClient;

  return yield* client.mutate("downloads.start", {
    profileId: request.profileId,
    deviceId: request.deviceId,
    titleId: request.titleId,
    capabilities: request.capabilities,
    ...Option.match(request.deviceName, {
      onNone: () => ({}),
      onSome: (deviceName) => ({ deviceName }),
    }),
    ...Option.match(request.episodeId, {
      onNone: () => ({}),
      onSome: (episodeId) => ({ episodeId }),
    }),
    ...Option.match(request.fileId, { onNone: () => ({}), onSome: (fileId) => ({ fileId }) }),
  });
});

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

/**
 * The session with a fresh token, which also keeps it from ending as idle. Renew before
 * `tokenExpiresAt`; the session ends an hour after a token expires unrenewed.
 */
export const renew = Effect.fn("Downloads.renew")(function* (started: StartedPlayback) {
  const client = yield* MoviesClient;

  const renewed = yield* client.mutate("playback.renewToken", {
    sessionId: started.sessionId,
  });

  return withRenewedToken(started, renewed);
});
