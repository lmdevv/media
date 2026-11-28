/**
 * The files a burned-in text subtitle is drawn from, written under one stream's own folder, which
 * the stream deletes when it ends: the track as ASS on the source's timeline, and the fonts the
 * media file carries. Both come from library files, so both are untrusted. The track is converted
 * by ffmpeg into a file of the service's naming; a sidecar is read where it is and never changed.
 * Fonts are taken from the file's attachments only by stream index, into files the service names:
 * a name the file gives is never a path. Only font types are kept, within a count, a size each, a
 * size in all, and a time, each file checked to be a regular file that starts as a font does.
 */
import { Context, Data, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

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

/** The track could not be read or converted, so nothing can be drawn from it. */
export class BurnTextFailed extends Schema.TaggedError<
  BurnTextFailed,
  { readonly brand: unique symbol }
>()("BurnTextFailed", { reason: Schema.Literals(["unreadable", "timed-out"]) }) {
  override get message(): string {
    return `Burned-in text subtitle failed: the track was ${this.reason === "timed-out" ? "not read in time" : "unreadable"}`;
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

/** The most fonts a stream extracts; a file with more keeps the first, in stream order. */
export const MAX_FONTS = 64;

/** The largest font file extracted; a CJK font with every glyph is near 20 MiB. */
export const MAX_FONT_BYTES = 32 * 1024 * 1024;

/** The most font bytes one stream extracts in all, which libass then holds in memory. */
export const MAX_FONT_TOTAL = 128 * 1024 * 1024;

/** How long extracting the fonts may take before it stops and the subtitle draws without them. */
const FONT_EXTRACTION_TIMEOUT = Duration.seconds(20);

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

const NAMESPACE = "burned-subtitles";

const CACHE_MAX_AGE = Duration.days(3650);

/** Why converting the track failed: it ran out of time, or ffmpeg could not read it. */
const failed = (error: MediaTools.MediaToolFailed) =>
  new BurnTextFailed({
    reason: error.exitCode === null && error.signal === null ? "timed-out" : "unreadable",
  });

/**
 * ffmpeg's arguments that write `source`'s track as ASS to `output`: copied from ASS and SSA,
 * converted from plain text; an embedded track keeps the file's timestamps (`-copyts`), and a
 * sidecar's, counted from the file's first frame, move there (`-itsoffset`).
 */
const assArgs = (source: BurnSource, output: string): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
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
  "-y",
  output,
];

const make = Effect.gen(function* () {
  const tools = yield* MediaTools.Service;
  const cache = yield* DiskCache.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* MediaConfig.Service;

  /** The track as ASS text: from the cache for an embedded track read before, else converted. */
  const writeTrack = Effect.fnUntraced(function* (source: BurnSource, output: string) {
    const key = TextSource.$match(source.text, {
      Embedded: ({ stream }) =>
        Option.some(
          `${source.file.fileId}:${String(source.file.sizeBytes)}:${String(source.file.modifiedAtMs)}:${String(stream)}:${source.style}`,
        ),
      Sidecar: () => Option.none<string>(),
    });

    const cached = Option.isSome(key)
      ? yield* cache.read(NAMESPACE, key.value, CACHE_MAX_AGE)
      : Option.none<string>();

    if (Option.isSome(cached)) {
      yield* fs
        .writeFileString(output, cached.value)
        .pipe(Effect.mapError(() => new BurnTextFailed({ reason: "unreadable" })));

      return;
    }

    yield* tools
      .ffmpeg(assArgs(source, output), { timeout: config.fileScanTimeout })
      .pipe(Effect.mapError(failed));

    if (Option.isSome(key)) {
      const text = yield* fs
        .readFileString(output)
        .pipe(Effect.mapError(() => new BurnTextFailed({ reason: "unreadable" })));

      yield* cache.write(NAMESPACE, key.value, text);
    }
  });

  /** Whether `file` is a regular file, not a link, of at most `bytes`, that starts as a font. */
  const isFont = (file: string, bytes: number) =>
    Effect.gen(function* () {
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
    yield* tools
      .ffmpeg(
        [
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
        ],
        { timeout: FONT_EXTRACTION_TIMEOUT },
      )
      .pipe(Effect.ignore);

    let kept = 0;

    for (const font of files) {
      if (yield* isFont(font.file, font.bytes)) kept += 1;
      else yield* fs.remove(font.file).pipe(Effect.ignore);
    }

    return kept === 0 ? undefined : folder;
  });

  const prepare = Effect.fn("BurnedText.prepare")(function* (source: BurnSource, folder: string) {
    const subtitle = path.join(folder, "subtitle.ass");

    yield* fs
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.mapError(() => new BurnTextFailed({ reason: "unreadable" })));
    yield* writeTrack(source, subtitle);

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
