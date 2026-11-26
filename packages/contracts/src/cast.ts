/**
 * Casting to Google's default receiver (ADR 0018): what a Chromecast plays, and the receiver
 * credential its URLs carry instead of a personal ticket (ADR 0011).
 *
 * A movie negotiates through the same ladder as any other client, with the profile here. Every
 * Chromecast plays 1080p H.264 (up to level 4.1) with AAC, over fMP4 HLS or as an MP4 file; HEVC,
 * 4K, and HDR are offered only to models that report playing them (Chromecast Ultra, Chromecast
 * with Google TV, Google TV Streamer), each decoding them in hardware. Cast senders report no codec
 * list, so the model name is the only evidence, and an unknown model gets the safe profile; no
 * profile offers AV1, which only some models decode. The web sender SDK reports no model
 * at all, so the web app always asks for the safe profile; native senders, whose SDKs report the
 * model, can ask for more. A song plays as its original file when every Chromecast decodes it
 * (MP3, AAC), and as the AAC 320 kbps transcode otherwise.
 *
 * A receiver fetches media by URL and holds no session, so the sender trades its start's ticket
 * for a receiver credential (`POST /api/playback/receiver`) and puts that in the ticket's place.
 * The credential reads and continues only the playback the ticket started, never starts a stream,
 * and lasts as long as that playback's admission on the media server while the session is live
 * (D46).
 */
import { Schema } from "effect";

import type { ClientCapabilities } from "./media-playback";
import { PlaybackSessionEnded, PlaybackTokenInvalid } from "./media-playback";
import { MUSIC_ROUTES } from "./music-playback";
import type { MusicStreamProfile } from "./music-playback";
import { TICKET_PARAM } from "./ticket";

const UHD_MODEL = /\b(?:ultra|google tv)\b/iu;

const H264_PROFILES = ["Constrained Baseline", "Baseline", "Main", "High"];

const HD_CAPABILITIES: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [
    { codec: "h264", profiles: H264_PROFILES, maxLevel: 41, maxBitDepth: 8, powerEfficient: true },
  ],
  audioCodecs: [
    { codec: "aac", maxChannels: 6 },
    { codec: "mp3", maxChannels: 2 },
  ],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
};

const UHD_CAPABILITIES: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [
    { codec: "h264", profiles: H264_PROFILES, maxLevel: 51, maxBitDepth: 8, powerEfficient: true },
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxLevel: 153,
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg"],
      powerEfficient: true,
    },
  ],
  audioCodecs: HD_CAPABILITIES.audioCodecs,
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

/** The profile of a cast device whose model is `modelName`, when the sender SDK reports one. */
export const castCapabilities = (modelName: string | undefined): ClientCapabilities =>
  UHD_MODEL.test(modelName ?? "") ? UHD_CAPABILITIES : HD_CAPABILITIES;

/** Whether every Chromecast decodes the music codec `codec`, as the scanner records it. */
const castDecodes = (codec: string): boolean => {
  const name = codec.toLowerCase();

  return (
    name.includes("mp3") ||
    name.includes("layer 3") ||
    name.includes("layer iii") ||
    name.includes("aac") ||
    name.includes("mp4a")
  );
};

/**
 * The stream profile a song casts at: its original file when every Chromecast decodes its codec,
 * else AAC 320 kbps. A Chromecast plays FLAC, Opus, and Vorbis only in some containers and at
 * some rates, and ALAC and WMA not at all, so those transcode.
 */
export const castMusicProfile = (codec: string): MusicStreamProfile =>
  castDecodes(codec) ? "original" : "aac-320";

/** The content type a receiver is told a song's stream at `profile` holds. */
export const castMusicContentType = (profile: MusicStreamProfile, codec: string): string => {
  if (profile !== "original") return "audio/mp4";

  const name = codec.toLowerCase();

  return name.includes("aac") || name.includes("mp4a") ? "audio/mp4" : "audio/mpeg";
};

/** The path of a song's stream, `MUSIC_ROUTES.stream`, with its id as the one group. */
const MUSIC_STREAM = new RegExp(MUSIC_ROUTES.stream.replace(":trackId", "([^/?#]+)"), "u");

/** The song a music stream URL plays, as its path names it; null for any other URL. */
export const streamedTrack = (url: string): string | null => {
  const id = MUSIC_STREAM.exec(url)?.[1];

  if (id === undefined) return null;

  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
};

/** IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`) and unspecified (`::ffff:0.0.0.0`) addresses. */
const MAPPED_LOCAL = /^\[::ffff:(?:7f[\da-f]{2}:[\da-f]{1,4}|0:0)\]$/u;

/**
 * Whether `mediaBaseUrl` names this computer only (`localhost`, a loopback address) or no computer
 * at all (`0.0.0.0`, `::`, a bind address), which a Chromecast on the network cannot reach.
 */
export const localOnly = (mediaBaseUrl: string): boolean => {
  const host = URL.canParse(mediaBaseUrl) ? new URL(mediaBaseUrl).hostname : "";

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "[::]" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    MAPPED_LOCAL.test(host)
  );
};

/** The media service's route that lends a receiver credential. */
export const CAST_ROUTES = {
  receiver: "/api/playback/receiver",
} as const;

/** A receiver credential's whole text: `r1.` and 43 base64url characters. */
const RECEIVER_CREDENTIAL = /^r1\.[\w-]{43}$/u;

/** Whether `text` has a receiver credential's shape. */
export const isReceiverCredential = (text: string): boolean => RECEIVER_CREDENTIAL.test(text);

/** A request for a receiver credential, with the ticket of the start the receiver plays. */
export const ReceiverRequest = Schema.Struct({
  token: Schema.Redacted(Schema.String),
});

/** A request for a receiver credential. */
export interface ReceiverRequest extends Schema.Schema.Type<typeof ReceiverRequest> {}

/** The receiver credential, which goes where the ticket went in each URL the receiver loads. */
export const ReceiverResponse = Schema.Struct({
  credential: Schema.Redacted(Schema.String),
});

/** The receiver credential. */
export interface ReceiverResponse extends Schema.Schema.Type<typeof ReceiverResponse> {}

/** Failures of `POST /api/playback/receiver`. */
export const ReceiverErrors = [PlaybackTokenInvalid, PlaybackSessionEnded] as const;

/**
 * `url` with `credential` in place of its ticket: the ticket parameter's value replaced, every
 * other parameter as it was. A URL without a ticket comes back unchanged.
 */
export const withReceiverCredential = (url: string, credential: string): string => {
  if (!URL.canParse(url)) return url;

  const parsed = new URL(url);

  if (!parsed.searchParams.has(TICKET_PARAM)) return url;
  parsed.searchParams.set(TICKET_PARAM, credential);

  return parsed.toString();
};
