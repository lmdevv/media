/**
 * The files a burned-in text subtitle is drawn from, written under one stream's own folder, which
 * the stream deletes when it ends: the track as ASS on the source's timeline, and the fonts the
 * media file carries. Both come from library files, so both are untrusted. The track is converted
 * by ffmpeg, within a size and a time, and kept only if it starts as an ASS script does; a sidecar
 * is read where it is and never changed. Fonts are taken from the file's attachments only by
 * stream index, into files the service names: a name the file gives is never a path. Only font
 * types are kept, within a count, a size each, a size in all, and a time, each file checked to be
 * a regular file that starts as a font does.
 */
import {
  Cache,
  Context,
  Data,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Hash,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect";

import * as DiskCache from "../disk-cache.ts";
import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { RunFiles } from "../playback/video-render.ts";

/** Where a text subtitle to burn in comes from. */
export type TextSource = Data.TaggedEnum<{
  /** A text track of the media file, by its ffmpeg stream index. */
  Embedded: { readonly stream: number };
  /** A subtitle file beside the media file, at its checked path. */
  Sidecar: { readonly path: string };
}>;

/** Constructors and matchers for `TextSource`. */
export const TextSource = Data.taggedEnum<TextSource>();

/** What preparing a burned-in text subtitle reads. */
export interface BurnSource {
  readonly file: {
    readonly fileId: string;
    /** The media file's checked path. */
    readonly path: string;
    readonly sizeBytes: number;
    readonly modifiedAtMs: number;
    /** Timestamp of the file's first frame, which a sidecar's times count from. */
    readonly startSeconds: number;
  };
  readonly text: TextSource;
  /** Whether the track keeps its own styles (ASS, SSA) or is plain text ffmpeg converts. */
  readonly style: "styled" | "plain";
}

/** The largest track as ASS, in bytes: a track that converts to this or more is refused. */
export const MAX_SCRIPT_BYTES = 32 * 1024 * 1024;

const FAILURES = {
  unreadable: "the track was unreadable",
  "timed-out": "the track was not read in time",
  "too-large": `the track is ${String(MAX_SCRIPT_BYTES / 1024 / 1024)} MiB or more as ASS`,
  "not-a-script": "the track does not start as an ASS script",
} as const;

/** The track could not be read or converted, so nothing can be drawn from it. */
export class BurnTextFailed extends Schema.TaggedError<
  BurnTextFailed,
  { readonly brand: unique symbol }
>()("BurnTextFailed", {
  reason: Schema.Literals(["unreadable", "timed-out", "too-large", "not-a-script"]),
}) {
  override get message(): string {
    return `Burned-in text subtitle failed: ${FAILURES[this.reason]}`;
  }
}

/** Writes the files a burned-in text subtitle is drawn from. */
export interface Interface {
  /**
   * Writes `source`'s track as `subtitle.ass` under `folder`, on the source's timeline, and the
   * media file's fonts under `folder/fonts`, and returns their paths: `fonts` only when a font
   * was kept. A track that cannot be read fails; fonts that cannot be read are left out.
   */
  readonly prepare: (source: BurnSource, folder: string) => Effect.Effect<RunFiles, BurnTextFailed>;
}

/** The burned-in text preparer. */
export class Service extends Context.Service<Service, Interface>()("@media/server/BurnedText") {}

/** Codecs and sidecar formats whose own styles, positions, and fonts are kept. */
const STYLED: ReadonlySet<string> = new Set(["ass", "ssa"]);

/** Whether a track of `codec` (or a sidecar of that format) is drawn with its own styles. */
export const textStyle = (codec: string): "styled" | "plain" =>
  STYLED.has(codec) ? "styled" : "plain";

/**
 * Text codecs ffmpeg decodes into text it can write as ASS, by ffmpeg codec name, and the sidecar
 * formats. Teletext and ARIB captions are left out, as their decoders can make pictures, which
 * ffmpeg cannot write as text.
 */
const CONVERTIBLE: ReadonlySet<string> = new Set([
  "ass",
  "ssa",
  "subrip",
  "srt",
  "webvtt",
  "vtt",
  "mov_text",
  "text",
  "microdvd",
  "subviewer",
  "subviewer1",
  "sami",
  "realtext",
  "jacosub",
  "mpl2",
  "pjs",
  "vplayer",
  "stl",
  "eia_608",
]);

/** Whether a text track of `codec` (or a sidecar of that format) can be burned in. */
export const burnableText = (codec: string): boolean => CONVERTIBLE.has(codec);

/** The most fonts a stream extracts; a file with more keeps the first, in stream order. */
export const MAX_FONTS = 64;

/** The largest font file extracted; a CJK font with every glyph is near 20 MiB. */
export const MAX_FONT_BYTES = 32 * 1024 * 1024;

/** The most font bytes one stream extracts in all, which libass then holds in memory. */
export const MAX_FONT_TOTAL = 128 * 1024 * 1024;

/** How many tracks are converted at once, as many as WebVTT conversions (`subtitle-tracks.ts`). */
const MAX_CONVERSIONS = 2;

/** Attachment types that are fonts, as Matroska muxers tag them. */
const FONT_TYPES: ReadonlySet<string> = new Set([
  "application/x-truetype-font",
  "application/x-font-ttf",
  "application/x-font-truetype",
  "application/x-font-otf",
  "application/x-font-opentype",
  "application/vnd.ms-opentype",
  "application/font-sfnt",
  "font/ttf",
  "font/otf",
  "font/sfnt",
  "font/collection",
]);

/** ffmpeg's codecs for font attachments. */
const FONT_CODECS: ReadonlySet<string> = new Set(["ttf", "otf"]);

/**
 * The first four bytes of a font FreeType loads: TrueType (`00 01 00 00`, `true`), OpenType with
 * CFF outlines (`OTTO`), and a collection (`ttcf`).
 */
const FONT_SIGNATURES: ReadonlySet<string> = new Set([
  "00010000",
  "74727565",
  "4f54544f",
  "74746366",
]);

const Attachment = Schema.Struct({
  index: Schema.Int,
  codec_name: Schema.optionalKey(Schema.String),
  extradata_size: Schema.optionalKey(Schema.Int),
  tags: Schema.optionalKey(Schema.Struct({ mimetype: Schema.optionalKey(Schema.String) })),
});

/** An attachment stream as ffprobe lists it. */
export interface Attachment extends Schema.Schema.Type<typeof Attachment> {}

const decodeAttachments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ streams: Schema.optionalKey(Schema.Array(Attachment)) })),
);

/** A font attachment the file says it has, and its size as the file states it. */
interface FontAttachment {
  readonly index: number;
  readonly bytes: number;
}

/**
 * The attachments to extract: fonts by codec or type, in stream order, each within
 * `MAX_FONT_BYTES`, as many as fit within `MAX_FONTS` and `MAX_FONT_TOTAL`. The sizes are what the
 * file states; each extracted file is checked again.
 */
export const fontsToExtract = (
  attachments: ReadonlyArray<Attachment>,
): ReadonlyArray<FontAttachment> => {
  const chosen: Array<FontAttachment> = [];
  let total = 0;

  for (const attachment of attachments) {
    const bytes = attachment.extradata_size ?? 0;
    const type = attachment.tags?.mimetype?.toLowerCase();

    const font =
      (attachment.codec_name !== undefined && FONT_CODECS.has(attachment.codec_name)) ||
      (type !== undefined && FONT_TYPES.has(type));

    if (
      font &&
      bytes > 0 &&
      bytes <= MAX_FONT_BYTES &&
      chosen.length < MAX_FONTS &&
      total + bytes <= MAX_FONT_TOTAL
    ) {
      chosen.push({ index: attachment.index, bytes });
      total += bytes;
    }
  }

  return chosen;
};

/**
 * Whether `text` starts as an ASS or SSA script does, as ffmpeg's ASS reader tells one: with its
 * `[Script Info]` section, after a byte order mark and blank lines. The `subtitles` filter picks
 * its reader by a file's content, so a track copied with a stored header that starts otherwise,
 * such as `WEBVTT`, would be read as another format or not at all.
 */
export const isAssScript = (text: string): boolean => /^\uFEFF?[\r\n]*\[Script Info\]/u.test(text);

/** `text` as the track to draw, or why it is not one. */
const script = (text: string): Effect.Effect<string, BurnTextFailed> =>
  Buffer.byteLength(text) >= MAX_SCRIPT_BYTES
    ? Effect.fail(new BurnTextFailed({ reason: "too-large" }))
    : isAssScript(text)
      ? Effect.succeed(text)
      : Effect.fail(new BurnTextFailed({ reason: "not-a-script" }));

/** Whether `file` is a regular file, not a link, of at most `bytes`, that starts as a font. */
export const isFont = (
  file: string,
  bytes: number,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const linked = yield* fs.readLink(file).pipe(Effect.option);
    const info = yield* fs.stat(file);

    if (Option.isSome(linked) || info.type !== "File" || Number(info.size) > bytes) return false;

    const head = yield* Effect.scoped(
      fs.open(file, { flag: "r" }).pipe(Effect.flatMap((opened) => opened.readAlloc(4))),
    );

    return Option.match(head, {
      onNone: () => false,
      onSome: (start) => FONT_SIGNATURES.has(Buffer.from(start).toString("hex")),
    });
  }).pipe(Effect.orElseSucceed(() => false));

const NAMESPACE = "burned-subtitles";

const CACHE_MAX_AGE = Duration.days(3650);

/**
 * Why converting the track failed: ffmpeg needed more than `MAX_ALLOCATION` in one block for it (a
 * header past the bound), or ffmpeg could not read it or did not start. Running out of time is the
 * conversion's own limit (`timed-out`), not a failure of the run.
 */
const failed = (error: MediaTools.MediaToolFailed) =>
  new BurnTextFailed({
    reason: error.stderr.includes("Cannot allocate memory") ? "too-large" : "unreadable",
  });

/**
 * The most ffmpeg allocates in one block while it converts a track: twice `MAX_SCRIPT_BYTES`, as
 * it doubles a buffer while it reads a script's header. A header past it fails to open, or reads
 * as nothing, where a 100 MiB `[Fonts]` section held ffmpeg at 769 MiB (sidecar) and 872 MiB
 * (Matroska) under ffmpeg 9.0.1, and 132 and 76 MiB with it.
 */
const MAX_ALLOCATION = 2 * MAX_SCRIPT_BYTES;

/**
 * ffmpeg's arguments that write `source`'s track as ASS to file descriptor 3 (`pipe:3`), which the
 * service reads within `MAX_SCRIPT_BYTES` (`readWithin`): copied from ASS and SSA, converted from
 * plain text; an embedded track keeps the file's timestamps (`-copyts`), and a sidecar's, counted
 * from the file's first frame, move there (`-itsoffset`).
 */
const assArgs = (source: BurnSource): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-max_alloc",
  String(MAX_ALLOCATION),
  ...TextSource.$match(source.text, {
    Embedded: ({ stream }) => ["-copyts", "-i", source.file.path, "-map", `0:${String(stream)}`],
    Sidecar: ({ path: sidecar }) => [
      "-itsoffset",
      source.file.startSeconds.toFixed(6),
      "-copyts",
      "-i",
      sidecar,
      "-map",
      "0:s:0",
    ],
  }),
  "-c:s",
  source.style === "styled" ? "copy" : "ass",
  "-f",
  "ass",
  "pipe:3",
];

/**
 * The text `output` carries, read only while it stays under `limit` bytes: undefined once the
 * bytes read reach it, when the reading stops and the pipe closes, so no more than `limit` and one
 * piece of it are ever held.
 */
export const readWithin = async (
  output: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<string | undefined> => {
  const pieces: Array<Uint8Array> = [];
  let read = 0;

  for await (const piece of output) {
    read += piece.length;

    if (read >= limit) return undefined;
    pieces.push(piece);
  }

  return Buffer.concat(pieces).toString("utf8");
};

/**
 * An embedded track to convert, equal to any other with the same cache key (the file's version,
 * the stream, and the style), so concurrent first burns of one track share one conversion.
 */
class EmbeddedTrack implements Equal.Equal {
  readonly key: string;
  readonly source: BurnSource;

  constructor(key: string, source: BurnSource) {
    this.key = key;
    this.source = source;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof EmbeddedTrack && that.key === this.key;
  }

  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

const make = Effect.gen(function* () {
  const tools = yield* MediaTools.Service;
  const cache = yield* DiskCache.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* MediaConfig.Service;

  const conversions = yield* Semaphore.make(MAX_CONVERSIONS);

  /**
   * `source`'s track converted to ASS, one of `MAX_CONVERSIONS` at a time, read within the bound
   * as ffmpeg writes it; a track that reaches it stops ffmpeg, which leaving the scope kills.
   */
  const convert = (source: BurnSource) =>
    conversions.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* tools
            .startFfmpegPiped(assArgs(source))
            .pipe(Effect.mapError(failed));

          const text = yield* Effect.tryPromise({
            try: () => readWithin(running.output, MAX_SCRIPT_BYTES),
            catch: () => new BurnTextFailed({ reason: "unreadable" }),
          });

          if (text === undefined) return yield* new BurnTextFailed({ reason: "too-large" });

          yield* running.exit.pipe(Effect.mapError(failed));

          return yield* script(text);
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: config.fileScanTimeout,
          orElse: () => Effect.fail(new BurnTextFailed({ reason: "timed-out" })),
        }),
      ),
    );

  /**
   * An embedded track's script: from the disk cache when a conversion of this version of the file
   * kept it, else converted and kept. Callers asking for one track while it converts share that
   * conversion; nothing is held in memory after it ends.
   */
  const embedded = yield* Cache.make({
    capacity: 1024,
    timeToLive: Duration.zero,
    lookup: (track: EmbeddedTrack) =>
      Effect.gen(function* () {
        const cached = yield* cache.read(NAMESPACE, track.key, CACHE_MAX_AGE);
        const kept = Option.isSome(cached) ? yield* Effect.option(script(cached.value)) : cached;

        if (Option.isSome(kept)) return kept.value;

        const text = yield* convert(track.source);

        yield* cache.write(NAMESPACE, track.key, text);

        return text;
      }),
  });

  /** `source`'s track as ASS text: an embedded one by way of the cache, a sidecar converted. */
  const trackText = (source: BurnSource) =>
    TextSource.$match(source.text, {
      Embedded: ({ stream }) =>
        Cache.get(
          embedded,
          new EmbeddedTrack(
            `${source.file.fileId}:${String(source.file.sizeBytes)}:${String(source.file.modifiedAtMs)}:${String(stream)}:${source.style}`,
            source,
          ),
        ),
      Sidecar: () => convert(source),
    });

  /** Extracts the media file's fonts under `folder`; the folder when one was kept, else none. */
  const writeFonts = Effect.fnUntraced(function* (source: BurnSource, folder: string) {
    const listed = yield* tools
      .ffprobe([
        "-v",
        "error",
        "-select_streams",
        "t",
        "-show_entries",
        "stream=index,codec_name,extradata_size:stream_tags=mimetype",
        "-of",
        "json",
        source.file.path,
      ])
      .pipe(Effect.flatMap(decodeAttachments));

    const fonts = fontsToExtract(listed.streams ?? []);

    if (fonts.length === 0) return undefined;

    const files = fonts.map((font, order) => ({
      index: font.index,
      bytes: font.bytes,
      file: path.join(folder, `${String(order)}.font`),
    }));

    yield* fs.makeDirectory(folder, { recursive: true });
    // ffmpeg writes each attachment as it opens the file, then needs an output: a frame of nothing.
    // Attachments are read with the file's header, so this has the probe timeout, as any run but
    // a whole-file read does.
    yield* tools
      .ffmpeg([
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        ...files.flatMap((font) => [`-dump_attachment:${String(font.index)}`, font.file]),
        "-i",
        source.file.path,
        "-f",
        "lavfi",
        "-i",
        "nullsrc=size=16x16:duration=0.04",
        "-map",
        "1:v",
        "-f",
        "null",
        "-",
      ])
      .pipe(Effect.ignore);

    let kept = 0;

    for (const font of files) {
      if (
        yield* isFont(font.file, font.bytes).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      )
        kept += 1;
      else yield* fs.remove(font.file).pipe(Effect.ignore);
    }

    return kept === 0 ? undefined : folder;
  });

  const prepare = Effect.fn("BurnedText.prepare")(function* (source: BurnSource, folder: string) {
    const subtitle = path.join(folder, "subtitle.ass");

    const text = yield* trackText(source);

    yield* fs.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(subtitle, text)),
      Effect.mapError(() => new BurnTextFailed({ reason: "unreadable" })),
    );

    const fonts = yield* writeFonts(source, path.join(folder, "fonts")).pipe(
      Effect.tapError((error) => Effect.logWarning("BurnedText.fonts_unread", error)),
      Effect.orElseSucceed(() => undefined),
    );

    return fonts === undefined ? { subtitle } : { subtitle, fonts };
  });

  return Service.of({ prepare });
});

/** The preparer over ffmpeg, the disk cache, and the file system. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaTools.Service | DiskCache.Service | FileSystem.FileSystem | Path.Path | MediaConfig.Service
> = Layer.effect(Service, make);
