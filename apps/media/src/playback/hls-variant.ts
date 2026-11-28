/**
 * What an HDR stream's multivariant playlist says of its one variant (Apple's HLS authoring
 * specification, section 9): the codecs as RFC 6381 names them, the picture, the frame rate, the
 * bitrates, and the range Apple's players present it in. An SDR stream has no variant: its
 * playlist is the media playlist alone, as it always was.
 */
import type { AudioTrack } from "../media/media-probe.ts";
import type { Variant } from "./hls-plan.ts";
import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import { rowOf } from "./video-pipeline.ts";

/** The AAC object type each profile ffprobe names is, which its codec string ends with. */
const AAC_OBJECT_TYPES: ReadonlyMap<string, number> = new Map([
  ["Main", 1],
  ["LC", 2],
  ["LTP", 4],
  ["HE-AAC", 5],
  ["HE-AACv2", 29],
]);

/** The codec strings of the audio codecs a stream copies; AAC's depends on its profile. */
const COPIED_AUDIO: ReadonlyMap<string, string> = new Map([
  ["mp3", "mp4a.40.34"],
  ["ac3", "ac-3"],
  ["eac3", "ec-3"],
  ["opus", "Opus"],
  ["flac", "fLaC"],
  ["alac", "alac"],
]);

/** The bitrate the AAC a stream converts audio to is encoded at (`transcode-command.ts`). */
const AAC_BITRATE = 192_000;

/**
 * The most a copied track of each codec is counted at, its common ceiling: AAC's for 5.1, AC-3's
 * and E-AC-3's top streaming rates, and lossless FLAC and ALAC at 5.1, 24 bits, and 48 kHz.
 */
const COPIED_AUDIO_BITRATES: ReadonlyMap<string, number> = new Map([
  ["aac", 576_000],
  ["mp3", 320_000],
  ["ac3", 640_000],
  ["eac3", 1_536_000],
  ["opus", 510_000],
]);

/** What a copied track of a codec the table above does not list is counted at. */
const LOSSLESS_AUDIO_BITRATE = 6_912_000;

/**
 * How far over the encode's bitrate a segment may run. Every encode row buffers twice its bitrate
 * (`-bufsize`), and the peak a segment of 4 s reaches over its bitrate is at most that buffer
 * spread over it.
 */
const PEAK_SHARE = 1.5;

/** A track's codec string and bitrate, as the stream delivers it. */
interface DeliveredAudio {
  readonly codec: string | undefined;
  readonly bitrate: number;
}

/** What `audio` delivers of `track`: AAC LC at its rate, a copy as it is, or nothing. */
const audioOf = (audio: AudioPlan, track: AudioTrack | undefined): DeliveredAudio | undefined =>
  AudioPlan.$match(audio, {
    None: () => undefined,
    Aac: () => ({ codec: "mp4a.40.2", bitrate: AAC_BITRATE }),
    Copy: () => {
      const name = track?.codec ?? "";

      return {
        codec:
          name === "aac"
            ? `mp4a.40.${String(AAC_OBJECT_TYPES.get(track?.profile ?? "LC") ?? 2)}`
            : COPIED_AUDIO.get(name),
        bitrate: COPIED_AUDIO_BITRATES.get(name) ?? LOSSLESS_AUDIO_BITRATE,
      };
    },
  });

/**
 * The variant a stream that runs `video` and `audio` (of `track`) is served as, when it keeps the
 * source's HDR: the codec string its encoder states it writes (HEVC Main 10 at the level the encode
 * states, which every HDR target's does), its size and frame rate, its bitrate with the audio's,
 * and `PQ` for HDR10 or `HLG`. None for a copy or an SDR encode, whose playlist stays the media
 * playlist alone.
 */
export const variantOf = (
  video: VideoPlan,
  audio: AudioPlan,
  track: AudioTrack | undefined,
): Variant | undefined => {
  if (!VideoPlan.$is("Encode")(video)) return undefined;
  const { output, intent, pipeline } = video;
  const encode = pipeline.steps.at(-1);
  const codec = encode === undefined ? undefined : rowOf(encode.impl)?.codecString(encode.op);

  if (
    output.dynamicRange === "sdr" ||
    output.dynamicRange === "dolby-vision" ||
    codec === undefined
  ) {
    return undefined;
  }

  const sound = audioOf(audio, track);
  const audioBits = sound?.bitrate ?? 0;

  return {
    bandwidth: output.bitrate * PEAK_SHARE + audioBits,
    averageBandwidth: output.bitrate + audioBits,
    codecs: [codec, ...(sound?.codec === undefined ? [] : [sound.codec])],
    resolution: { width: output.width, height: output.height },
    frameRate: intent.frameRate,
    videoRange: output.dynamicRange === "hdr10" ? "PQ" : "HLG",
  };
};
