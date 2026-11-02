/**
 * ffmpeg arguments for one HLS generation. Output keeps the source timeline (`-copyts` with
 * `frag_discont`, never shifted to avoid negative timestamps), so every fragment's video times
 * (its `tfdt` and `trun`, read past the init segment's edit list) match the session's segment
 * plan wherever a run starts, and the HLS muxer starts a new
 * fragment file at every keyframe; the session groups fragments into the planned segments.
 * Transcodes place keyframes on the planned segment starts. Encodes run in software (libx264), on
 * Intel Quick Sync, or through VA-API (Intel and AMD); a GPU decodes the source itself when it
 * can, and tone-maps HDR to SDR (`vpp_qsv`, `tonemap_vaapi`), as does the software path with
 * `zscale`.
 */
import { AudioPlan, VideoPlan } from "./playback-decision.ts";

/** Everything one ffmpeg run needs; built only from server-side state. */
export interface HlsCommand {
  readonly input: string;
  /** Timestamp of the file's first frame; `-ss` positions are relative to it. */
  readonly sourceStart: number;
  /** First planned segment start this run produces, on the source timeline. */
  readonly from: number;
  readonly videoIndex: number;
  readonly videoCodec: string;
  readonly videoBitDepth: number;
  readonly video: VideoPlan;
  readonly audio: AudioPlan;
  /** ffprobe's name for the source audio track's codec, such as `aac`; empty without audio. */
  readonly audioCodec: string;
  /** Where a copied audio track ends on the source timeline, when its probe says. */
  readonly copiedAudioEnd: number | undefined;
  /** ffprobe's name for the burned-in subtitle's codec, such as `dvd_subtitle`; empty without. */
  readonly subtitleCodec: string;
  /** Planned segment starts at or after `from`; transcodes force keyframes there. */
  readonly segmentStarts: ReadonlyArray<number>;
  /**
   * The planned segment start before `from`, a keyframe when video is copied; none at the first.
   */
  readonly previousStart: number | undefined;
  readonly outputDirectory: string;
  readonly qsvDevice: string;
  readonly vaapiDevice: string;
}

type EncodeSource = Omit<HlsCommand, "input" | "outputDirectory">;

/** Everything one ffmpeg run that writes a whole file as MP4 needs, for a download. */
export interface Mp4Command {
  readonly input: string;
  readonly videoIndex: number;
  readonly videoCodec: string;
  readonly videoBitDepth: number;
  /** A copy, or an encode without a burned-in subtitle. */
  readonly video: VideoPlan;
  readonly audio: AudioPlan;
  /** ffprobe's name for the source audio track's codec, such as `aac`; empty without audio. */
  readonly audioCodec: string;
  readonly qsvDevice: string;
  readonly vaapiDevice: string;
  /** The MP4 to write. */
  readonly output: string;
  /** Where ffmpeg writes `key=value` progress (`out_time_us`) as it goes. */
  readonly progress: string;
}

/** Codecs Intel (Quick Sync, VA-API) and AMD (VA-API) media engines decode in hardware. */
const HARDWARE_DECODERS: ReadonlySet<string> = new Set([
  "h264",
  "hevc",
  "av1",
  "vp9",
  "mpeg2video",
]);

/**
 * HDR to SDR in software: linearize, map with Hable onto 100 nits, convert to BT.709. Needs
 * ffmpeg's `zscale` (libzimg) and `tonemap`; negotiation checks for them first.
 */
const SOFTWARE_TONE_MAP =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

const seconds = (value: number): string => value.toFixed(6);

type Encode = Extract<VideoPlan, { readonly _tag: "Encode" }>;

interface FilterGraph {
  readonly kind: "simple" | "complex";
  readonly graph: string;
}

const decodesOnGpu = (command: EncodeSource, video: Encode): boolean =>
  video.encoder !== "software" && HARDWARE_DECODERS.has(command.videoCodec);

const gpuFilters = (command: EncodeSource, video: Encode, uploaded: boolean): string => {
  const size = `w=${String(video.width)}:h=${String(video.height)}`;

  const upload = uploaded
    ? ""
    : `format=${command.videoBitDepth > 8 ? "p010le" : "nv12"},hwupload${video.encoder === "qsv" ? "=extra_hw_frames=64" : ""},`;

  if (video.encoder === "qsv") {
    const toneMapping = video.toneMap
      ? ":tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709"
      : "";

    return `${upload}vpp_qsv=${size}:format=nv12${toneMapping}`;
  }

  const toneMapping = video.toneMap ? "tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709," : "";

  return `${upload}${toneMapping}scale_vaapi=${size}:format=nv12`;
};

/**
 * The video filter graph: scale and tone-map on the CPU or the GPU. An image subtitle is drawn
 * on the finished SDR picture at the output size, after tone mapping (subtitles are SDR): in
 * software straight away, on a GPU after downloading its frames, which are then uploaded again
 * for the encoder. The subtitle's canvas (720x576 for DVD) is scaled to the picture it covers.
 * After a seek, picture frames from before `from` still configure the graph, so trimming them
 * comes first and they skip the rest of the work. ffmpeg appears to repeat the subtitle's current
 * image as it reads packets, so a caption that started earlier survives trimming the subtitle's own
 * frames to shortly before `from`. Untrimmed, memory peaked near 4 GB at 1080p, apparently scaled
 * frames waiting on the overlay.
 */
const videoFilters = (command: EncodeSource, video: Encode): FilterGraph => {
  const width = String(video.width);
  const height = String(video.height);

  const picture =
    video.encoder === "software"
      ? [
          `scale=${width}:${height}:flags=bicubic`,
          ...(video.toneMap ? [SOFTWARE_TONE_MAP] : []),
        ].join(",")
      : gpuFilters(command, video, decodesOnGpu(command, video));

  if (video.burnSubtitle === undefined) {
    return {
      kind: "simple",
      graph: video.encoder === "software" ? `${picture},format=yuv420p` : picture,
    };
  }

  const seeked = subtitleReading(command).seeked;
  const pictureTrim = seeked ? `trim=start=${seconds(command.from)},` : "";
  const subtitleTrim = seeked ? `trim=start=${seconds(command.from - SUBTITLE_MARGIN)},` : "";

  const [download, upload] =
    video.encoder === "software"
      ? ["", "format=yuv420p"]
      : [
          ",hwdownload,format=nv12",
          `format=nv12,hwupload${video.encoder === "qsv" ? "=extra_hw_frames=64,format=qsv" : ""}`,
        ];

  return {
    kind: "complex",
    graph: [
      `[0:${String(command.videoIndex)}]${pictureTrim}${picture}${download}[picture]`,
      `[0:${String(video.burnSubtitle)}]${subtitleTrim}scale=${width}:${height}[subtitle]`,
      `[picture][subtitle]overlay=eof_action=pass:repeatlast=0,${upload}[video]`,
    ].join(";"),
  };
};

const videoArgs = (command: EncodeSource): ReadonlyArray<string> =>
  VideoPlan.$match(command.video, {
    Copy: () => [
      "-map",
      `0:${String(command.videoIndex)}`,
      "-c:v",
      "copy",
      ...(command.videoCodec === "hevc" ? ["-tag:v", "hvc1"] : []),
    ],
    Encode: (video) => {
      const keyframes =
        command.segmentStarts.length === 0
          ? []
          : ["-force_key_frames", command.segmentStarts.map(seconds).join(",")];

      const rate = String(video.bitrate);
      const filters = videoFilters(command, video);

      const graph =
        filters.kind === "simple"
          ? ["-map", `0:${String(command.videoIndex)}`, "-vf", filters.graph]
          : ["-filter_complex", filters.graph, "-map", "[video]"];

      if (video.encoder === "software") {
        return [
          ...graph,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-profile:v",
          "high",
          "-crf",
          "23",
          "-maxrate",
          rate,
          "-bufsize",
          String(video.bitrate * 2),
          ...keyframes,
        ];
      }

      const bitrate = ["-b:v", rate, "-maxrate", rate, "-bufsize", String(video.bitrate * 2)];

      return video.encoder === "qsv"
        ? [
            ...graph,
            "-c:v",
            "h264_qsv",
            "-preset",
            "veryfast",
            ...bitrate,
            "-forced_idr",
            "1",
            ...keyframes,
          ]
        : [...graph, "-c:v", "h264_vaapi", "-profile:v", "high", ...bitrate, ...keyframes];
    },
  });

/**
 * Copied AAC from MPEG-TS (and other ADTS sources) carries ADTS headers that MP4 refuses; the
 * filter rewrites them and passes AAC that has none through unchanged.
 */
const copyBitstreamFilter = (codec: string): ReadonlyArray<string> =>
  codec === "aac" ? ["aac_adtstoasc"] : [];

interface AudioTiming {
  readonly input: 0 | 1;
  readonly copyFilters: ReadonlyArray<string>;
  readonly aac: ReadonlyArray<string>;
}

const audioArgs = (command: EncodeSource, timing: AudioTiming): ReadonlyArray<string> =>
  AudioPlan.$match(command.audio, {
    None: () => ["-an"],
    Copy: ({ index }) => {
      const filters = [...copyBitstreamFilter(command.audioCodec), ...timing.copyFilters];

      return [
        "-map",
        `${String(timing.input)}:${index}`,
        "-c:a",
        "copy",
        ...(filters.length === 0 ? [] : ["-bsf:a", filters.join(",")]),
      ];
    },
    Aac: ({ index }) => [
      "-map",
      `${String(timing.input)}:${index}`,
      ...timing.aac,
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "192k",
    ],
  });

const AAC_RATE = 48_000;

const AAC_FRAME_SAMPLES = 1024;

const AUDIO_LEAD = 0.5;

/** How far past `from` copied audio must run on before an encode drops what ends by `from`. */
const AUDIO_END_MARGIN = 0.5;

const samplesAt = (time: number): number => Math.round(time * AAC_RATE);

const frameFloor = (samples: number): number =>
  Math.floor(samples / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;

const frameCeil = (samples: number): number =>
  Math.ceil(samples / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;

/** Copied audio packets a run drops: those starting before a time, or those ending by it. */
interface CopiedAudioDrop {
  readonly time: number;
  readonly by: "start" | "end";
}

interface RunStart {
  readonly seek: number | undefined;
  readonly audioStartSample: number;
  readonly dropCopiedAudio: CopiedAudioDrop | undefined;
}

/**
 * Drops copied packets by the times they keep under `-copyts`, where `-copypriorss` compares them
 * with the input's `-ss`, which stays relative to a file that starts later than 0, such as
 * MPEG-TS.
 */
const dropFilter = ({ time, by }: CopiedAudioDrop): string =>
  by === "start"
    ? `noise=drop=lt(pts*tb\\,${seconds(time)})`
    : `noise=drop=lte((pts+d)*tb\\,${seconds(time)})`;

/**
 * Resamples to `AAC_RATE`, then times frames by their sample count from `audioStartSample`, so
 * every AAC frame lasts 1024 samples however much the source's timestamps jitter. A gap or overlap
 * in those timestamps longer than a frame (`min_hard_comp`) becomes silence or is cut, so audio
 * stays on the source timeline; the default, 0.1 s, let a 60 ms gap play everything after it
 * early. `first_pts` counts the filter's input samples, so the rate changes in a filter first.
 */
const aacTiming = (audioStartSample: number): ReadonlyArray<string> => [
  "-af",
  `aresample=${String(AAC_RATE)},aresample=async=1:min_hard_comp=0.02:first_pts=${String(audioStartSample)}`,
];

/**
 * Every run's AAC frames sit on one grid of 1024-sample frames from the source timeline's zero,
 * and start a frame after the file, so no priming frame has a negative timestamp. A run that
 * copies video seeks to the previous planned start, a keyframe, so it has a fragment to drop even
 * where a seek lands near its target rather than on a keyframe, as in MPEG-TS: the muxer then
 * cuts the first planned segment's audio at the frame an earlier run cut, and the session drops
 * the fragments before it. Its audio starts earlier still, so the first fragment has audio and
 * `init.mp4` the same edit lists as other runs'. An encode drops copied audio that ends by `from`
 * only when the track runs on past `from`: an MP4 track without a packet has no `init.mp4` entry
 * for AC-3 or E-AC-3, so where the end is unknown nothing is dropped.
 */
const runStart = (command: EncodeSource): RunStart => {
  const fileAudioStart = frameCeil(Math.max(0, samplesAt(command.sourceStart))) + AAC_FRAME_SAMPLES;

  const fromFile: RunStart = {
    seek: undefined,
    audioStartSample: fileAudioStart,
    dropCopiedAudio: { time: 0, by: "start" },
  };

  if (VideoPlan.$is("Copy")(command.video)) {
    if (command.previousStart === undefined) return fromFile;

    const seek = command.previousStart;
    const audioStartSample = frameFloor(samplesAt(seek - AUDIO_LEAD));

    return audioStartSample > fileAudioStart
      ? { seek: seek - command.sourceStart, audioStartSample, dropCopiedAudio: undefined }
      : fromFile;
  }

  const offset = command.from - command.sourceStart;

  if (offset <= 0.001) return fromFile;

  return {
    seek: offset,
    audioStartSample: Math.max(fileAudioStart, frameFloor(samplesAt(command.from))),
    dropCopiedAudio:
      command.copiedAudioEnd !== undefined &&
      command.copiedAudioEnd >= command.from + AUDIO_END_MARGIN
        ? { time: command.from, by: "end" }
        : undefined,
  };
};

/**
 * The `-init_hw_device` value for Quick Sync on the render node `device`. With oneVPL builds,
 * `qsv=hw:<path>` ignores the path and opens the default GPU, so the node is named as the child
 * VA-API device instead; a missing node then fails, as it should.
 */
export const qsvDeviceInit = (device: string): string => `qsv=hw,child_device=${device}`;

const hardwareInput = (command: EncodeSource): ReadonlyArray<string> => {
  const video = command.video;

  if (!VideoPlan.$is("Encode")(video) || video.encoder === "software") return [];
  const onGpu = decodesOnGpu(command, video);

  if (video.encoder === "qsv") {
    return [
      "-init_hw_device",
      qsvDeviceInit(command.qsvDevice),
      "-filter_hw_device",
      "hw",
      ...(onGpu ? ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"] : []),
    ];
  }

  return [
    "-init_hw_device",
    `vaapi=va:${command.vaapiDevice}`,
    "-filter_hw_device",
    "va",
    ...(onGpu
      ? ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-hwaccel_device", "va"]
      : []),
  ];
};

/**
 * Subtitles that started before the seek point are still on screen there, but a seek skips
 * their packets. A run that burns one in after a seek therefore reads the picture and the subtitle
 * together from `SUBTITLE_LEAD` earlier, and the filter graph trims the picture back to `from`;
 * audio keeps its own reading from the seek. Picture and subtitle must share a reading: ffmpeg
 * 8.0.1 loses a subtitle's end of file that arrives before the first picture frame, then waits on
 * that input forever, and a reading of its own can reach the end first. A run from the start reads
 * once.
 */
const SUBTITLE_LEAD = 30;

/**
 * How long before `from` a burned-in subtitle's frames are kept after a seek. Trimming at `from`
 * itself loses captions; this exceeds the frame reordering in the files tested (`-bf 8`).
 */
const SUBTITLE_MARGIN = 1;

/** DVD subtitles carry no canvas size; without one ffmpeg sizes them to the video and crops. */
const DVD_CANVAS = "720x576";

const seekArgs = (seek: number | undefined): ReadonlyArray<string> =>
  seek === undefined ? [] : ["-ss", seconds(seek)];

const subtitleReading = (command: EncodeSource) => {
  const video = command.video;
  const burning = VideoPlan.$is("Encode")(video) && video.burnSubtitle !== undefined;
  const offset = command.from - command.sourceStart;

  return {
    canvas: burning && command.subtitleCodec === "dvd_subtitle" ? ["-canvas_size", DVD_CANVAS] : [],
    seeked: burning && offset > 0.001,
    lead: offset - SUBTITLE_LEAD > 0.001 ? offset - SUBTITLE_LEAD : undefined,
  };
};

/** The full ffmpeg argument list for `command`. */
export const hlsCommandArgs = (command: HlsCommand): ReadonlyArray<string> => {
  const start = runStart(command);
  const subtitles = subtitleReading(command);
  const audioInput = subtitles.seeked && !AudioPlan.$is("None")(command.audio) ? 1 : 0;

  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "error",
    ...hardwareInput(command),
    ...subtitles.canvas,
    ...seekArgs(subtitles.seeked ? subtitles.lead : start.seek),
    "-copyts",
    "-i",
    command.input,
    ...(audioInput === 1 ? [...seekArgs(start.seek), "-copyts", "-i", command.input] : []),
    ...videoArgs(command),
    ...audioArgs(command, {
      input: audioInput,
      copyFilters: start.dropCopiedAudio === undefined ? [] : [dropFilter(start.dropCopiedAudio)],
      aac: aacTiming(start.audioStartSample),
    }),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-max_muxing_queue_size",
    "4096",
    "-avoid_negative_ts",
    "disabled",
    "-f",
    "hls",
    "-hls_time",
    "0.1",
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "temp_file",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_options",
    "movflags=+frag_discont",
    "-start_number",
    "0",
    "-hls_segment_filename",
    `${command.outputDirectory}/f%d.m4s`,
    `${command.outputDirectory}/ffmpeg.m3u8`,
  ];
};

/**
 * The ffmpeg arguments for `command`: the whole file from its start, the planned video and audio,
 * no subtitles, metadata, or chapters, and the index moved to the front (`+faststart`), so AVPlayer
 * opens the finished file at once. Progress goes to `command.progress`.
 */
export const mp4CommandArgs = (command: Mp4Command): ReadonlyArray<string> => {
  const source: EncodeSource = {
    sourceStart: 0,
    from: 0,
    videoIndex: command.videoIndex,
    videoCodec: command.videoCodec,
    videoBitDepth: command.videoBitDepth,
    video: command.video,
    audio: command.audio,
    audioCodec: command.audioCodec,
    copiedAudioEnd: undefined,
    subtitleCodec: "",
    segmentStarts: [],
    previousStart: undefined,
    qsvDevice: command.qsvDevice,
    vaapiDevice: command.vaapiDevice,
  };

  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "error",
    "-progress",
    command.progress,
    ...hardwareInput(source),
    "-i",
    command.input,
    ...videoArgs(source),
    ...audioArgs(source, { input: 0, copyFilters: [], aac: [] }),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-max_muxing_queue_size",
    "4096",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-y",
    command.output,
  ];
};
