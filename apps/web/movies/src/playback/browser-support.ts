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

/**
 * The Media Capabilities API's answers to whether this browser plays 4K HEVC Main 10 in BT.2020 by
 * transfer, asked the first time detection reads one, as `efficient` is.
 */
const hdr = new Map<"pq" | "hlg", boolean | undefined>();

const askHdr = (transfer: "pq" | "hlg", kind: MediaDecodingType): void => {
  hdr.set(transfer, undefined);
  navigator.mediaCapabilities
    .decodingInfo({
      type: kind,
      video: {
        contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
        width: 3840,
        height: 2160,
        bitrate: 20_000_000,
        framerate: 24,
        colorGamut: "rec2020",
        transferFunction: transfer,
        ...hdrMetadataOf(transfer),
      },
    })
    .then(
      (info) => hdr.set(transfer, info.supported),
      () => hdr.delete(transfer),
    );
};

/** HDR10's static metadata, which a PQ stream carries; HLG carries none. */
const hdrMetadataOf = (transfer: "pq" | "hlg"): Pick<VideoConfiguration, "hdrMetadataType"> =>
  transfer === "pq" ? { hdrMetadataType: "smpteSt2086" } : {};

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
    hdrDecodes: (transfer) => {
      if (!hdr.has(transfer) && "mediaCapabilities" in navigator) askHdr(transfer, kind);

      return hdr.get(transfer);
    },
  };
};

/** Whether setting `volume` on a media element takes effect; iPhones ignore it. */
export const volumeIsSettable = (): boolean => {
  const probe = document.createElement("video");

  probe.volume = 0.5;

  return probe.volume === 0.5;
};
