/**
 * ffmpeg arguments for one HLS generation. Output keeps the source timeline (`-copyts` with
 * `frag_discont`, never shifted to avoid negative timestamps), so every fragment's video times
 * (its `tfdt` and `trun`, read past the init segment's edit list) match the session's segment
 * plan wherever a run starts, and the HLS muxer starts a new
 * fragment file at every keyframe; the session groups fragments into the planned segments.
 * Copies skip the per-fragment `sidx` (`skip_sidx`): without it, the muxer's DASH mode presents
 * each fragment's first sample where the previous fragment's pictures end, which at an open-GOP
 * keyframe is where its leading pictures start: frames before its own time, the time plans use.
 * Transcodes place keyframes on the planned segment starts. An encode renders its pipeline
 * (`video-render.ts`): the device its GPU stages open, the decoder's flags, one filter graph, and
 * the encoder, each stage on the CPU or a GPU as the plan placed it. HEVC, copied or encoded, is
 * written with the `hvc1` sample entry Apple's players require (parameter sets in the sample entry
 * only); ffmpeg's default for it is `hev1`. H.264 (`avc1`) and AV1 (`av01`) have one entry each.
 */
import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import type { LogOwners } from "./transcode-recovery.ts";
import { type VideoPipeline } from "./video-pipeline.ts";
import { graphArgs, type RenderedVideo, renderVideo, type RunFiles } from "./video-render.ts";
import { Op, type Size, statedCanvas } from "./video-ops.ts";

/** Everything one ffmpeg run needs; built only from server-side state. */
export interface HlsCommand {
  readonly input: string;
  /** Timestamp of the file's first frame; `-ss` positions are relative to it. */
  readonly sourceStart: number;
  /** First planned segment start this run produces, on the source timeline. */
  readonly from: number;
  readonly videoIndex: number;
  /** ffprobe's name for the source video's codec, which a copy keeps. */
  readonly videoCodec: string;
  readonly video: VideoPlan;
  readonly audio: AudioPlan;
  /** ffprobe's name for the source audio track's codec, such as `aac`; empty without audio. */
  readonly audioCodec: string;
  /** Where a copied audio track ends on the source timeline, when its probe says. */
  readonly copiedAudioEnd: number | undefined;
  /** Planned segment starts at or after `from`; transcodes force keyframes there. */
  readonly segmentStarts: ReadonlyArray<number>;
  /** The files a burned-in text subtitle is drawn from, written under the stream's folder. */
  readonly files: RunFiles;
  /**
   * The planned segment start before `from`, a keyframe when video is copied; none at the first.
   */
  readonly previousStart: number | undefined;
  readonly outputDirectory: string;
}

/** An HLS run's arguments, and which of its steps owns each name in ffmpeg's log. */
export interface HlsRun {
  readonly args: ReadonlyArray<string>;
  /** None for a copy, which runs no pipeline. */
  readonly owners: LogOwners | undefined;
}

type EncodeSource = Omit<HlsCommand, "input" | "outputDirectory">;

/** Everything one ffmpeg run that writes a whole file as MP4 needs, for a download. */
export interface Mp4Command {
  readonly input: string;
  readonly videoIndex: number;
  readonly videoCodec: string;
  /** A copy, or an encode without a burned-in subtitle. */
  readonly video: VideoPlan;
  readonly audio: AudioPlan;
  /** ffprobe's name for the source audio track's codec, such as `aac`; empty without audio. */
  readonly audioCodec: string;
  /** The MP4 to write. */
  readonly output: string;
  /** Where ffmpeg writes `key=value` progress (`out_time_us`) as it goes. */
  readonly progress: string;
}

const seconds = (value: number): string => value.toFixed(6);

type Encode = Extract<VideoPlan, { readonly _tag: "Encode" }>;

/** The image subtitle a pipeline draws onto the picture, if it burns one in. */
const burnedSubtitle = (pipeline: VideoPipeline) => {
  const burn = pipeline.steps.find((step) => Op.$is("BurnImage")(step.op))?.op;

  return burn !== undefined && Op.$is("BurnImage")(burn) ? burn.subtitle : undefined;
};

/**
 * Renders an encode's pipeline for this run. An image subtitle is drawn on the finished SDR
 * picture at the output size. After a seek, picture frames earlier than `from` still configure
 * the graph, so trimming them comes first and they skip the rest of the work. ffmpeg appears to
 * repeat the subtitle's current image as it reads packets, so a caption that started earlier
 * survives trimming the subtitle's own frames to shortly before `from`. Untrimmed, memory peaked
 * near 4 GB at 1080p, apparently scaled frames waiting on the overlay. A text subtitle is drawn
 * from the ASS file and fonts the stream wrote (`files`) on the source's timeline: libass holds
 * the whole script, so a cue that began before a seek shows at once, and the run reads once.
 */
const rendered = (command: EncodeSource, video: Encode): RenderedVideo => {
  const seeked = subtitleReading(command).seeked;

  return renderVideo(video.pipeline, {
    input: 0,
    stream: command.videoIndex,
    trimPicture: seeked ? command.from : undefined,
    trimSubtitle: seeked ? command.from - SUBTITLE_MARGIN : undefined,
    files: command.files,
  });
};

/** The sample entry the output's video track is written with, for the codec it delivers. */
const sampleEntry = (codec: string): ReadonlyArray<string> =>
  codec === "hevc" ? ["-tag:v", "hvc1"] : [];

const videoArgs = (
  command: EncodeSource,
  encoded: RenderedVideo | undefined,
): ReadonlyArray<string> =>
  encoded === undefined || !VideoPlan.$is("Encode")(command.video)
    ? [
        "-map",
        `0:${String(command.videoIndex)}`,
        "-c:v",
        "copy",
        ...sampleEntry(command.videoCodec),
      ]
    : [
        ...graphArgs(encoded, { input: 0, stream: command.videoIndex }),
        ...encoded.output,
        ...sampleEntry(command.video.output.codec),
        ...(command.segmentStarts.length === 0
          ? []
          : ["-force_key_frames", command.segmentStarts.map(seconds).join(",")]),
      ];

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

/** `-canvas_size` for a canvas the service states (`statedCanvas`); other inputs stay as filed. */
const canvasArgs = (canvas: Size | undefined): ReadonlyArray<string> =>
  canvas === undefined ? [] : ["-canvas_size", `${String(canvas.width)}x${String(canvas.height)}`];

const seekArgs = (seek: number | undefined): ReadonlyArray<string> =>
  seek === undefined ? [] : ["-ss", seconds(seek)];

const subtitleReading = (command: EncodeSource) => {
  const video = command.video;
  const subtitle = VideoPlan.$is("Encode")(video) ? burnedSubtitle(video.pipeline) : undefined;
  const burning = subtitle !== undefined;
  const offset = command.from - command.sourceStart;

  return {
    canvas: canvasArgs(subtitle === undefined ? undefined : statedCanvas(subtitle.codec)),
    seeked: burning && offset > 0.001,
    lead: offset - SUBTITLE_LEAD > 0.001 ? offset - SUBTITLE_LEAD : undefined,
  };
};

/** The full ffmpeg argument list for `command`, and which steps own the names in its log. */
export const hlsCommand = (command: HlsCommand): HlsRun => {
  const start = runStart(command);
  const subtitles = subtitleReading(command);
  const audioInput = subtitles.seeked && !AudioPlan.$is("None")(command.audio) ? 1 : 0;
  const video = command.video;
  const encoded = VideoPlan.$is("Encode")(video) ? rendered(command, video) : undefined;

  const args = [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "error",
    ...(encoded?.input ?? []),
    ...subtitles.canvas,
    ...seekArgs(subtitles.seeked ? subtitles.lead : start.seek),
    "-copyts",
    "-i",
    command.input,
    ...(audioInput === 1 ? [...seekArgs(start.seek), "-copyts", "-i", command.input] : []),
    ...videoArgs(command, encoded),
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
    VideoPlan.$is("Copy")(command.video)
      ? "movflags=+frag_discont+skip_sidx"
      : "movflags=+frag_discont",
    "-start_number",
    "0",
    "-hls_segment_filename",
    `${command.outputDirectory}/f%d.m4s`,
    `${command.outputDirectory}/ffmpeg.m3u8`,
  ];

  return { args, owners: encoded?.owners };
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
    video: command.video,
    audio: command.audio,
    audioCodec: command.audioCodec,
    copiedAudioEnd: undefined,
    segmentStarts: [],
    files: {},
    previousStart: undefined,
  };

  const video = command.video;
  const encoded = VideoPlan.$is("Encode")(video) ? rendered(source, video) : undefined;

  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "error",
    "-progress",
    command.progress,
    ...(encoded?.input ?? []),
    "-i",
    command.input,
    ...videoArgs(source, encoded),
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
