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
import { Data, Result } from "effect";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import { burnableText } from "../subtitles/burned-text.ts";
import {
  type CapabilitySnapshot,
  encodeDomain,
  planVideo,
  sourceOf,
  type VideoIntent,
  type VideoOutput,
  type VideoPipeline,
} from "./video-pipeline.ts";
import {
  type Burn,
  Op,
  type OutputCodec,
  type OutputTarget,
  subtitleCanvas,
  type TextSubtitle,
  toneMapsTo,
} from "./video-ops.ts";

/** What happens to the video stream. */
export type VideoPlan = Data.TaggedEnum<{
  Copy: {};
  Encode: {
    /** What the decision asked for: a replacement plans from it again and never relaxes it. */
    readonly intent: VideoIntent;
    readonly output: VideoOutput;
    readonly pipeline: VideoPipeline;
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

/** A subtitle track a viewer asked to have drawn into the picture. */
export type BurnRequest = Data.TaggedEnum<{
  /** An embedded image subtitle, by its ffmpeg stream index. */
  Image: { readonly stream: number };
  /** A text track, embedded or a sidecar, that libass draws. */
  Text: { readonly subtitle: Omit<TextSubtitle, "storage"> };
  /** A track the file does not have, or one that cannot be drawn in. */
  Refused: {};
}>;

/** Constructors and matchers for `BurnRequest`. */
export const BurnRequest = Data.taggedEnum<BurnRequest>();

/** What an encode is asked to fit: the viewer's cap and a subtitle to burn in. */
export interface EncodeRequest {
  /** The viewer's quality cap; none plays the best the client takes. */
  readonly quality?: PlaybackQuality | undefined;
  /** A subtitle track to draw into the picture. */
  readonly burnSubtitle?: BurnRequest | undefined;
}

/** Inputs besides the probe and the client. */
export interface DecisionOptions extends EncodeRequest {
  /** ffmpeg stream index of the requested audio track; the default track when absent. */
  readonly audioIndex: number | undefined;
  /** What this server's transcoder may use for this file. */
  readonly capabilities: CapabilitySnapshot;
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

type VideoCodecSupport = ClientCapabilities["videoCodecs"][number];

/** The profile, as ffprobe names it, of each codec's 8-bit SDR encode. */
const OUTPUT_PROFILES: Readonly<Record<OutputCodec, string>> = {
  h264: "High",
  hevc: "Main",
  av1: "Main",
};

/** What `client` says of `codec`, when it plays that codec's 8-bit SDR encode in its profile. */
const playable = (
  client: ClientCapabilities,
  codec: OutputCodec,
): VideoCodecSupport | undefined => {
  const support = videoSupport(client, codec);
  const profile = OUTPUT_PROFILES[codec].toLowerCase();

  return support !== undefined &&
    (support.profiles === undefined ||
      support.profiles.some((listed) => listed.toLowerCase() === profile))
    ? support
    : undefined;
};

/**
 * What an encode for `client` may produce, the most wanted first: HEVC when the client plays it;
 * AV1 when it decodes AV1 in hardware, or plays neither HEVC nor H.264; H.264 last, the broad
 * fallback. A CPU encodes H.264 when the client plays it, as software HEVC and AV1 cost several
 * times its CPU for a live stream, and HEVC or AV1 only for a client without H.264. Each target
 * carries the level the client declared for its codec, which HEVC and AV1 encodes fit; H.264 has
 * no level table, so its declared level limits nothing. Empty when the client plays none.
 */
export const outputTargets = (client: ClientCapabilities): ReadonlyArray<OutputTarget> => {
  const h264 = playable(client, "h264");
  const hevc = playable(client, "hevc");
  const av1 = playable(client, "av1");

  const av1Wanted =
    av1 !== undefined &&
    (av1.powerEfficient === true || (hevc === undefined && h264 === undefined));

  const wanted: ReadonlyArray<readonly [OutputCodec, VideoCodecSupport | undefined]> = [
    ["hevc", hevc],
    ["av1", av1Wanted ? av1 : undefined],
    ["h264", h264],
  ];

  return wanted.flatMap(([codec, support]): ReadonlyArray<OutputTarget> =>
    support === undefined
      ? []
      : [
          {
            codec,
            depth: 8,
            colour: "sdr",
            cpuEncode: codec === "h264" || h264 === undefined ? "allowed" : "refused",
            level: support.maxLevel,
          },
        ],
  );
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
 * Whether `request` names a subtitle this file can have drawn in: one of its image tracks, or a
 * text track the caller found among its embedded tracks or its sidecars, in a codec ffmpeg can
 * write as ASS.
 */
const burnable = (probe: MediaProbe, request: BurnRequest): boolean =>
  BurnRequest.$match(request, {
    Image: ({ stream }) =>
      probe.subtitles.some((track) => track.index === stream && track.kind === "bitmap"),
    Text: ({ subtitle }) => burnableText(subtitle.codec),
    Refused: () => false,
  });

/**
 * Chooses how to deliver `probe` to `client`. A quality cap that would need an encode this host
 * cannot do (HDR without tone mapping, a client that plays nothing it encodes to) is dropped, so
 * the viewer still gets the source rather than nothing; a subtitle to burn in is not, as nothing
 * else shows it.
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

  if (burnSubtitle !== undefined && !burnable(probe, burnSubtitle)) {
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
      mode: modeOf(VideoPlan.Copy(), audioPlan),
      video: VideoPlan.Copy(),
      audio: audioPlan,
    });
  }

  const intent = encodeIntent(probe, video, client, options);

  const encoded =
    intent === undefined
      ? Result.fail<UnsupportedReason>("no-transcode-target")
      : replan(video, intent, options.capabilities);

  return Result.match(encoded, {
    onSuccess: (plan) =>
      PlaybackPlan.Hls({ mode: modeOf(plan, audioPlan), video: plan, audio: audioPlan }),
    onFailure: (reason) => PlaybackPlan.Unsupported({ reason }),
  });
};

/**
 * What an encode of `video` for `client` asks for: the client's targets (`outputTargets`), each
 * tone-mapped from an HDR source when it is SDR, within the client's size and the viewer's cap,
 * the CPU within 1920x1080. Undefined when the client plays nothing the transcoder encodes to.
 */
export const encodeIntent = (
  probe: MediaProbe,
  video: VideoStream,
  client: ClientCapabilities,
  request: EncodeRequest,
): VideoIntent | undefined => {
  const targets = outputTargets(client);

  if (targets.length === 0) return undefined;

  return {
    targets,
    frameRate: video.frameRate,
    bounds: {
      width: client.maxWidth,
      height: Math.min(client.maxHeight, request.quality?.maxHeight ?? Number.POSITIVE_INFINITY),
    },
    cpuEncodeBounds: SOFTWARE_MAX,
    maxBitrate: request.quality?.maxBitrate,
    burn:
      request.burnSubtitle === undefined ? undefined : burnOf(probe, video, request.burnSubtitle),
  };
};

/**
 * The operation that draws `request` into `video`'s picture: an image track read from the file as
 * frames of its own, or a text track libass draws at the source's size; none for a refused one.
 */
const burnOf = (probe: MediaProbe, video: VideoStream, request: BurnRequest): Burn | undefined =>
  BurnRequest.$match(request, {
    Image: ({ stream }): Burn | undefined => {
      const subtitle = probe.subtitles.find((track) => track.index === stream);

      return subtitle === undefined
        ? undefined
        : Op.BurnImage({
            subtitle: {
              input: 0,
              stream: subtitle.index,
              codec: subtitle.codec,
              frame: {
                memory: "cpu",
                device: undefined,
                colour: "sdr",
                depth: 8,
                pixelFormat: "pal8",
                scan: "progressive",
                ...subtitleCanvas(subtitle.codec, video),
              },
            },
          });
    },
    Text: ({ subtitle }): Burn =>
      Op.BurnText({
        subtitle: { ...subtitle, storage: { width: video.width, height: video.height } },
      }),
    Refused: (): Burn | undefined => undefined,
  });

/**
 * Plans `intent` for `video` again from `capabilities`, as a replacement after a failure does: the
 * same output intent and caps, never relaxed, and always an encode.
 */
export const replan = (
  video: VideoStream,
  intent: VideoIntent,
  capabilities: CapabilitySnapshot,
): Result.Result<Extract<VideoPlan, { readonly _tag: "Encode" }>, UnsupportedReason> =>
  Result.match(planVideo(sourceOf(video), intent, capabilities), {
    onSuccess: ({ output, pipeline }) =>
      Result.succeed(VideoPlan.Encode({ intent, output, pipeline })),
    onFailure: () =>
      Result.fail(
        drawsNoSubtitle(video, intent, capabilities)
          ? "subtitle-not-burnable"
          : intent.targets.some((target) => toneMapsTo(video.dynamicRange, target))
            ? "hdr-tone-mapping-requires-hardware"
            : "no-transcode-target",
      ),
  });

/**
 * Whether the subtitle alone keeps `intent` from planning: the same encode without it plans. No
 * row this build proved draws it then, as on a build without libass (`subtitles`).
 */
const drawsNoSubtitle = (
  video: VideoStream,
  intent: VideoIntent,
  capabilities: CapabilitySnapshot,
): boolean =>
  intent.burn !== undefined &&
  Result.isSuccess(planVideo(sourceOf(video), { ...intent, burn: undefined }, capabilities));

/**
 * How a plan delivers the file, the one place the mode comes from: copied video is a remux, or an
 * audio transcode when the audio is converted; encoded video is named for the domain its encoder
 * runs in, software for the CPU.
 */
export const modeOf = (video: VideoPlan, audio: AudioPlan): Exclude<PlaybackMode, "direct"> =>
  VideoPlan.$match(video, {
    Copy: () => (AudioPlan.$is("Aac")(audio) ? "audio-transcode" : "remux"),
    Encode: ({ pipeline }) => {
      const domain = encodeDomain(pipeline);

      return domain === "cpu" ? "transcode-software" : (`transcode-${domain}` as const);
    },
  });
