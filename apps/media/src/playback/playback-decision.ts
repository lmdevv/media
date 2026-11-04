import {
  canonicalCodec as canonical,
  decodesAudio,
  decodesVideo,
  videoSupport,
} from "@media/contracts/direct-play";
import type {
  ClientCapabilities,
  PlaybackQuality,
  UnsupportedReason,
} from "@media/contracts/media-playback";
import type { PlaybackMode } from "@media/contracts/models/playback";
import { Data } from "effect";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import type { HardwareEncoder } from "./hardware-acceleration.ts";

/** What happens to the video stream. */
export type VideoPlan = Data.TaggedEnum<{
  Copy: {};
  Encode: {
    readonly encoder: HardwareEncoder | "software";
    readonly width: number;
    readonly height: number;
    /** HDR to SDR conversion. */
    readonly toneMap: boolean;
    readonly bitrate: number;
    /** ffmpeg stream index of an image subtitle drawn onto the picture. */
    readonly burnSubtitle: number | undefined;
  };
}>;

/** Constructors and matchers for `VideoPlan`. */
export const VideoPlan = Data.taggedEnum<VideoPlan>();

/** What happens to the selected audio track. */
export type AudioPlan = Data.TaggedEnum<{
  None: {};
  Copy: { readonly index: number };
  /** Stereo AAC LC. */
  Aac: { readonly index: number };
}>;

/** Constructors and matchers for `AudioPlan`. */
export const AudioPlan = Data.taggedEnum<AudioPlan>();

/** The chosen rung. */
export type PlaybackPlan = Data.TaggedEnum<{
  Direct: { readonly audioIndex: number | undefined };
  Hls: {
    readonly mode: Exclude<PlaybackMode, "direct">;
    readonly video: VideoPlan;
    readonly audio: AudioPlan;
  };
  Unsupported: { readonly reason: UnsupportedReason };
}>;

/** Constructors and matchers for `PlaybackPlan`. */
export const PlaybackPlan = Data.taggedEnum<PlaybackPlan>();

/** Inputs besides the probe and the client. */
export interface DecisionOptions {
  /** ffmpeg stream index of the requested audio track; the default track when absent. */
  readonly audioIndex: number | undefined;
  /** The GPU encoder transcodes use; software when absent. */
  readonly hardware: HardwareEncoder | undefined;
  /** Whether this ffmpeg can tone-map HDR to SDR in software (`zscale` and `tonemap`). */
  readonly softwareToneMapping: boolean;
  /** The viewer's quality cap; none plays the best the client takes. */
  readonly quality?: PlaybackQuality | undefined;
  /** ffmpeg stream index of an embedded image subtitle to burn into the picture. */
  readonly burnSubtitle?: number | undefined;
  /**
   * Whether the video may be copied (remux, audio-only transcode); false when the session must
   * encode, such as while the file's keyframes are still being indexed. Direct play is unaffected.
   */
  readonly copyVideo?: boolean;
}

const HLS_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264", "hevc", "av1", "vp9"]);

const HLS_AUDIO_CODECS: ReadonlySet<string> = new Set([
  "aac",
  "mp3",
  "ac3",
  "eac3",
  "opus",
  "flac",
  "alac",
]);

const SOFTWARE_MAX = { width: 1920, height: 1080 } as const;

const bitrateFor = (height: number): number =>
  height > 1440
    ? 20_000_000
    : height > 1080
      ? 12_000_000
      : height > 720
        ? 8_000_000
        : height > 480
          ? 4_000_000
          : 2_000_000;

const fit = (video: VideoStream, bounds: { readonly width: number; readonly height: number }) => {
  const scale = Math.min(1, bounds.width / video.width, bounds.height / video.height);
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);

  return { width: even(video.width), height: even(video.height) };
};

const selectAudio = (
  probe: MediaProbe,
  index: number | undefined,
): AudioTrack | undefined | "missing" => {
  if (index !== undefined) return probe.audio.find((track) => track.index === index) ?? "missing";

  return probe.audio.find((track) => track.default) ?? probe.audio[0];
};

const exceeds = (probe: MediaProbe, video: VideoStream, quality: PlaybackQuality | undefined) =>
  quality !== undefined &&
  ((quality.maxHeight !== undefined && video.height > quality.maxHeight) ||
    (quality.maxBitrate !== undefined &&
      probe.bitRate !== undefined &&
      probe.bitRate > quality.maxBitrate));

/**
 * Chooses how to deliver `probe` to `client`. A quality cap that would need an encode this host
 * cannot do (HDR without tone mapping, a client without H.264) is dropped, so the viewer still
 * gets the source rather than nothing; a subtitle to burn in is not, as nothing else shows it.
 */
export const decidePlayback = (
  probe: MediaProbe,
  client: ClientCapabilities,
  options: DecisionOptions,
): PlaybackPlan => {
  const plan = decideWithin(probe, client, options);

  return PlaybackPlan.$is("Unsupported")(plan) && options.quality !== undefined
    ? decideWithin(probe, client, { ...options, quality: undefined })
    : plan;
};

/**
 * Chooses how to deliver `probe` to `client` strictly within the viewer's cap: a cap this host
 * cannot encode within leaves `Unsupported`. Downloads use this, as their quality is a size limit.
 */
export const decideWithin = (
  probe: MediaProbe,
  client: ClientCapabilities,
  options: DecisionOptions,
): PlaybackPlan => {
  const { video } = probe;

  if (video === undefined) return PlaybackPlan.Unsupported({ reason: "no-video-stream" });
  const audio = selectAudio(probe, options.audioIndex);

  if (audio === "missing") return PlaybackPlan.Unsupported({ reason: "audio-track-not-found" });

  const burnSubtitle = options.burnSubtitle;

  if (
    burnSubtitle !== undefined &&
    !probe.subtitles.some((track) => track.index === burnSubtitle && track.kind === "bitmap")
  ) {
    return PlaybackPlan.Unsupported({ reason: "subtitle-not-burnable" });
  }

  const defaultAudio = probe.audio.find((track) => track.default) ?? probe.audio[0];

  const mustEncode = burnSubtitle !== undefined || exceeds(probe, video, options.quality);
  const videoOk = decodesVideo(client, video) && !mustEncode;
  const audioOk = audio === undefined || decodesAudio(client, audio);

  // Browsers play the file's default audio track; another track needs HLS.
  if (
    client.containers.includes(probe.container) &&
    videoOk &&
    audioOk &&
    audio?.index === defaultAudio?.index
  ) {
    return PlaybackPlan.Direct({ audioIndex: audio?.index });
  }

  if (!client.hls && !client.mse)
    return PlaybackPlan.Unsupported({ reason: "no-adaptive-streaming" });

  if (probe.durationSeconds <= 0) return PlaybackPlan.Unsupported({ reason: "unknown-duration" });

  const audioCopyable =
    audio !== undefined && audioOk && HLS_AUDIO_CODECS.has(canonical(audio.codec));

  const audioPlan =
    audio === undefined
      ? AudioPlan.None()
      : audioCopyable
        ? AudioPlan.Copy({ index: audio.index })
        : AudioPlan.Aac({ index: audio.index });

  if (videoOk && HLS_VIDEO_CODECS.has(canonical(video.codec)) && options.copyVideo !== false) {
    return PlaybackPlan.Hls({
      mode: audioCopyable || audio === undefined ? "remux" : "audio-transcode",
      video: VideoPlan.Copy(),
      audio: audioPlan,
    });
  }

  const h264 = videoSupport(client, "h264");

  if (h264 === undefined) return PlaybackPlan.Unsupported({ reason: "no-transcode-target" });
  const toneMap = video.dynamicRange !== "sdr";
  const encoder = options.hardware ?? "software";

  if (encoder === "software" && toneMap && !options.softwareToneMapping) {
    return PlaybackPlan.Unsupported({ reason: "hdr-tone-mapping-requires-hardware" });
  }

  const capHeight = options.quality?.maxHeight ?? Number.POSITIVE_INFINITY;
  const softwareMax = encoder === "software" ? SOFTWARE_MAX : { width: Infinity, height: Infinity };

  const size = fit(video, {
    width: Math.min(client.maxWidth, softwareMax.width),
    height: Math.min(client.maxHeight, softwareMax.height, capHeight),
  });

  return PlaybackPlan.Hls({
    mode: `transcode-${encoder}`,
    video: VideoPlan.Encode({
      encoder,
      ...size,
      toneMap,
      bitrate: Math.min(
        bitrateFor(size.height),
        options.quality?.maxBitrate ?? Number.POSITIVE_INFINITY,
      ),
      burnSubtitle,
    }),
    audio: audioPlan,
  });
};
