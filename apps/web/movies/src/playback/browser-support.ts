import type { MediaSupport } from "./capabilities";

/**
 * The Media Capabilities API's answers, by content type: whether 1080p of it decodes
 * power-efficiently. A type is asked about the first time capability detection reads it, so the
 * title page's detection fills this before the player's; until a type's answer arrives, it reads
 * as unknown, and the media service then never encodes AV1 for this browser's sake.
 */
const efficient = new Map<string, boolean | undefined>();

const askEfficiency = (type: string, kind: MediaDecodingType): void => {
  efficient.set(type, undefined);
  navigator.mediaCapabilities
    .decodingInfo({
      type: kind,
      video: { contentType: type, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 24 },
    })
    .then(
      (info) => efficient.set(type, info.supported && info.powerEfficient),
      () => efficient.delete(type),
    );
};

/** This browser's media checks. */
export const browserMediaSupport = (): MediaSupport => {
  const probe = document.createElement("video");

  const source =
    window.ManagedMediaSource ?? ("MediaSource" in window ? window.MediaSource : undefined);

  const kind: MediaDecodingType = source === undefined ? "file" : "media-source";

  return {
    canPlayType: (type) => probe.canPlayType(type),
    isTypeSupported: source === undefined ? null : (type: string) => source.isTypeSupported(type),
    hdrDisplay: window.matchMedia("(dynamic-range: high)").matches,
    powerEfficient: (type) => {
      if (!efficient.has(type) && "mediaCapabilities" in navigator) askEfficiency(type, kind);

      return efficient.get(type);
    },
  };
};

/** Whether setting `volume` on a media element takes effect; iPhones ignore it. */
export const volumeIsSettable = (): boolean => {
  const probe = document.createElement("video");

  probe.volume = 0.5;

  return probe.volume === 0.5;
};
