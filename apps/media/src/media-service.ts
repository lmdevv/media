import { Layer } from "effect";

import * as ArtworkStore from "./artwork/artwork-store.ts";
import * as ClientDiagnostics from "./diagnostics/client-events.ts";
import * as DiskCache from "./disk-cache.ts";
import * as Downloads from "./downloads/downloads.ts";
import * as LibraryScanner from "./library/library-scanner.ts";
import type * as MediaTools from "./media/media-tools.ts";
import type * as MediaConfig from "./media-config.ts";
import * as MetadataResolver from "./metadata/title-metadata.ts";
import * as Omdb from "./metadata/omdb.ts";
import * as Tmdb from "./metadata/tmdb.ts";
import * as HardwareAcceleration from "./playback/hardware-acceleration.ts";
import * as KeyframeIndex from "./playback/keyframe-index.ts";
import * as PlaybackNegotiator from "./playback/playback-negotiator.ts";
import * as StreamSessions from "./playback/stream-sessions.ts";
import * as TranscodeSpace from "./playback/transcode-space.ts";
import * as SubtitleConverter from "./subtitles/subtitle-tracks.ts";
import * as TrickplayStore from "./trickplay/trickplay-store.ts";

/**
 * Scanning, metadata, negotiation, streaming, players' diagnostics, downloads, and subtitles over
 * the integration seams, with `tools` running ffmpeg and ffprobe. The byte routes' grants
 * (`PlaybackToken`), the stream owner registry, and the artwork key codec come from outside: core
 * tickets, which read the registry, and artwork keys sealed under the server's own key on the
 * core; refusing grants and a key drawn at start in standalone mode.
 */
export const servicesLayerWith = (
  tools: Layer.Layer<MediaTools.Service, never, MediaConfig.Service>,
) =>
  Layer.mergeAll(
    PlaybackNegotiator.layer,
    Downloads.layer,
    LibraryScanner.layer,
    SubtitleConverter.layer,
    ClientDiagnostics.layer,
  ).pipe(
    Layer.provideMerge(StreamSessions.layer),
    Layer.provideMerge(TranscodeSpace.layer),
    Layer.provideMerge(KeyframeIndex.layer),
    Layer.provideMerge(HardwareAcceleration.layer),
    Layer.provideMerge(MetadataResolver.layer),
    Layer.provideMerge(ArtworkStore.layer),
    Layer.provideMerge(Tmdb.layer),
    Layer.provideMerge(Omdb.layer),
    Layer.provideMerge(DiskCache.layer),
    Layer.provideMerge(TrickplayStore.layer),
    Layer.provideMerge(tools),
  );
