import { dynamicRangeOf, playsDirectly as filePlaysDirectly } from "@media/contracts/direct-play";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import type { MediaVersion } from "@media/contracts/models/catalog";
import { Option } from "effect";

import { channelLabel, codecLabel, hdrLabel, resolutionLabel, sizeLabel } from "./media-labels";

/** Whether `client` plays `version` as stored: its container, video, and default audio track. */
export const playsDirectly = (version: MediaVersion, client: ClientCapabilities): boolean =>
  filePlaysDirectly(client, {
    container: version.container,
    video:
      version.videoCodec === null || version.width === null || version.height === null
        ? undefined
        : {
            codec: version.videoCodec,
            profile: version.videoProfile ?? undefined,
            level: version.videoLevel ?? undefined,
            bitDepth: version.videoBitDepth ?? 8,
            width: version.width,
            height: version.height,
            dynamicRange: dynamicRangeOf(version.hdr),
          },
    audio:
      version.audioCodec === null
        ? undefined
        : { codec: version.audioCodec, channels: version.audioChannels ?? 2 },
  });

/**
 * The version to offer first among `versions` (in `titles.versions` order, best quality first):
 * the one the profile last played, else the best that `client` plays as stored, else the best
 * quality. None when there are no versions.
 */
export const preferredVersion = (
  versions: ReadonlyArray<MediaVersion>,
  client: ClientCapabilities,
): Option.Option<MediaVersion> =>
  Option.fromNullishOr(
    versions.find((version) => version.lastPlayed) ??
      versions.find((version) => playsDirectly(version, client)) ??
      versions[0],
  );

const pictureClass = (version: MediaVersion): string | null =>
  version.width === null || version.height === null
    ? null
    : (resolutionLabel(version.width, version.height) ?? "SD");

/** A version's name: its edition or part, else its picture, such as `4K HEVC`, else its container. */
export const label = (version: MediaVersion): string =>
  version.versionName ??
  ([pictureClass(version), version.videoCodec === null ? null : codecLabel(version.videoCodec)]
    .filter((part) => part !== null)
    .join(" ") ||
    version.container.toUpperCase());

/**
 * What tells a version apart besides its name: `4K · HDR10 · HEVC · EAC3 5.1 · 41.2 GB`, with
 * `3 audio tracks` when it has several.
 */
export const detail = (version: MediaVersion): string =>
  [
    pictureClass(version),
    hdrLabel(version.hdr),
    version.videoCodec === null ? null : codecLabel(version.videoCodec),
    version.audioCodec === null
      ? null
      : [codecLabel(version.audioCodec), channelLabel(version.audioChannels ?? 0)]
          .filter((part) => part !== null)
          .join(" "),
    version.audioTracks > 1 ? `${String(version.audioTracks)} audio tracks` : null,
    sizeLabel(version.sizeBytes),
  ]
    .filter((part) => part !== null)
    .join(" · ");
