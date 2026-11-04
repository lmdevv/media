/**
 * The media service's Effect HttpApi: playback negotiation, HLS stream control, player
 * diagnostics, preparing downloads, health, and the connection details apps read. The
 * media service implements it; clients that may use Effect's unstable HTTP modules can derive an
 * `HttpApiClient` from it, and others decode the same schemas from `@media/contracts/media-playback`.
 *
 * Media bytes (direct files, HLS playlists and segments, WebVTT, artwork) are plain routes on the
 * media service, because `<video>`, `<img>`, and HLS players fetch them by URL. Registry `media`
 * commands (such as `metadata.searchCandidates`) answer with command failures instead and are
 * described by `@media/contracts/commands`.
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import {
  ClientDiagnosticsErrors,
  ClientDiagnosticsRequest,
  DIAGNOSTICS_ROUTES,
} from "./diagnostics";
import {
  ClientConfigResponse,
  HealthResponse,
  MEDIA_ROUTES,
  NegotiateErrors,
  NegotiateRequest,
  NegotiateResponse,
  PrepareDownloadErrors,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  SeekErrors,
  SeekRequest,
  SeekResponse,
  StopErrors,
  StopRequest,
} from "./media-playback";

/** Playback negotiation, HLS stream control, and the events players report. */
export class PlaybackGroup extends HttpApiGroup.make("playback").add(
  HttpApiEndpoint.post("negotiate", MEDIA_ROUTES.negotiate, {
    payload: NegotiateRequest,
    success: NegotiateResponse,
    error: NegotiateErrors,
  }),
  HttpApiEndpoint.post("seek", MEDIA_ROUTES.seek, {
    payload: SeekRequest,
    success: SeekResponse,
    error: SeekErrors,
  }),
  HttpApiEndpoint.post("stop", MEDIA_ROUTES.stop, {
    payload: StopRequest,
    success: HttpApiSchema.NoContent,
    error: StopErrors,
  }),
  HttpApiEndpoint.post("diagnostics", DIAGNOSTICS_ROUTES.clientEvents, {
    payload: ClientDiagnosticsRequest,
    success: HttpApiSchema.NoContent,
    error: ClientDiagnosticsErrors,
  }),
) {}

/** Downloads kept on a device: the file to fetch, written as an MP4 first when needed. */
export class DownloadsGroup extends HttpApiGroup.make("downloads").add(
  HttpApiEndpoint.post("prepare", MEDIA_ROUTES.prepareDownload, {
    payload: PrepareDownloadRequest,
    success: PrepareDownloadResponse,
    error: PrepareDownloadErrors,
  }),
) {}

/** Liveness and capability summary, and how apps find the Convex deployment. */
export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", MEDIA_ROUTES.health, { success: HealthResponse }),
  HttpApiEndpoint.get("clientConfig", MEDIA_ROUTES.clientConfig, { success: ClientConfigResponse }),
) {}

/** The media service API. */
export class MediaApi extends HttpApi.make("media")
  .add(PlaybackGroup)
  .add(DownloadsGroup)
  .add(SystemGroup) {}
