import type {
  DynamicRange,
  NegotiateResponse,
  TranscodeChange,
} from "@media/contracts/media-playback";
import type { HdrFormat, MediaFile } from "@media/contracts/models/catalog";
import { MediaLabels, TranscodeLabels } from "@media/sdk/effect";
import { useLiveValue } from "@media/ui/lib/live-value";
import type { LiveValue } from "@media/ui/lib/live-value";
import { cn } from "@media/ui/lib/utils";
import { XIcon } from "lucide-react";

const { channelLabel, codecLabel } = MediaLabels;

const { reasonLabel, stageLabel } = TranscodeLabels;

const RUNGS = [
  { id: "direct", label: "Direct" },
  { id: "remux", label: "Remux" },
  { id: "transcode", label: "Transcode" },
] as const;

const rungOf = (mode: NegotiateResponse["mode"]): (typeof RUNGS)[number]["id"] => {
  if (mode === "direct") return "direct";

  return mode === "remux" || mode === "audio-transcode" ? "remux" : "transcode";
};

const HDR_LABELS = {
  none: "SDR",
  hdr10: "HDR10",
  hdr10plus: "HDR10+",
  hlg: "HLG",
  dolby_vision: "Dolby Vision",
} as const satisfies Record<HdrFormat, string>;

const RANGE_LABELS = {
  sdr: "SDR",
  hdr10: "HDR10",
  hlg: "HLG",
  "dolby-vision": "Dolby Vision",
} as const satisfies Record<DynamicRange, string>;

const RUNG_TONES = {
  direct: "text-success",
  remux: "text-text",
  transcode: "text-warning",
} as const;

const sizeLabel = (width: number, height: number): string => {
  if (width >= 3200 || height >= 2000) return "4K";

  return `${String(height)}p`;
};

const megabits = (bitsPerSecond: number): string => (bitsPerSecond / 1_000_000).toFixed(1);

const pad = (part: number): string => String(part).padStart(2, "0");

/** `21:04 · probe failed too · tonemap.qsv`: when, why, and what the stream keeps off from then on. */
const changeLine = (change: TranscodeChange): string => {
  const at = new Date(change.at);
  const [first, ...rest] = change.excluded;

  return [
    `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    reasonLabel(change.reason),
    ...(first === undefined
      ? []
      : [rest.length === 0 ? first : `${first} +${String(rest.length)}`]),
  ].join(" · ");
};

interface Row {
  readonly label: string;
  readonly lines: ReadonlyArray<string>;
  /** The first line is where the rest came from, such as the source of a transcoded video. */
  readonly fromFirst?: true;
}

const CONTAINER_LABELS = new Map([
  ["mkv", "MKV"],
  ["mp4", "MP4"],
  ["mov", "MOV"],
  ["webm", "WebM"],
  ["avi", "AVI"],
  ["ts", "MPEG-TS"],
]);

const streamInfoRows = (
  file: MediaFile,
  stream: NegotiateResponse,
  bufferedAheadSeconds: number,
): ReadonlyArray<Row> => {
  const source = file.probe.video[0];

  const copiedVideo =
    stream.mode === "direct" || stream.mode === "remux" || stream.mode === "audio-transcode";

  const sourceVideo =
    source === undefined
      ? null
      : [
          `${codecLabel(source.codec)}${(source.bitDepth ?? 8) > 8 ? ` ${String(source.bitDepth)}-bit` : ""}`,
          sizeLabel(source.width, source.height),
          HDR_LABELS[source.hdr],
        ].join(" · ");

  const outputVideo = [
    codecLabel(stream.video.codec),
    sizeLabel(stream.video.width, stream.video.height),
    RANGE_LABELS[stream.video.dynamicRange],
  ].join(" · ");

  const sourceAudio = file.probe.audio.find((track) => track.index === stream.audio?.streamIndex);

  const audio =
    stream.audio === undefined
      ? "None"
      : [
          [codecLabel(stream.audio.codec), channelLabel(stream.audio.channels)]
            .filter((part) => part !== null)
            .join(" "),
          ...(sourceAudio?.bitRate === null || sourceAudio === undefined
            ? []
            : [`${String(Math.round(sourceAudio.bitRate / 1000))} kb/s`]),
          stream.mode === "audio-transcode" || !copiedVideo ? "converted" : "copy",
        ].join(" · ");

  const container =
    CONTAINER_LABELS.get(file.probe.container) ?? file.probe.container.toUpperCase();

  const stages = stream.transcode?.stages ?? [];
  const changes = stream.transcode?.changes ?? [];

  const rows: ReadonlyArray<Row> = [
    ...(file.versionName === null ? [] : [{ label: "Version", lines: [file.versionName] }]),
    copiedVideo || sourceVideo === null
      ? { label: "Video", lines: [sourceVideo ?? outputVideo] }
      : { label: "Video", lines: [sourceVideo, `→ ${outputVideo}`], fromFirst: true },
    ...(stages.length === 0 ? [] : [{ label: "Stages", lines: stages.map(stageLabel) }]),
    ...(changes.length === 0 ? [] : [{ label: "Changed", lines: changes.map(changeLine) }]),
    { label: "Audio", lines: [audio] },
    {
      label: "Container",
      lines: [stream.mode === "direct" ? container : `${container} → HLS fMP4`],
    },
    {
      label: "Bitrate",
      lines: [
        [
          ...(file.probe.bitRate === null ? [] : [`${megabits(file.probe.bitRate)} Mb/s`]),
          `buffer ${String(Math.round(bufferedAheadSeconds))} s`,
        ].join(" · "),
      ],
    },
  ];

  return rows;
};

/** The floating panel under the info button. */
export function StreamInfo({
  file,
  stream,
  bufferedAhead,
  onClose,
  className,
}: {
  readonly file: MediaFile;
  readonly stream: NegotiateResponse;
  /** Seconds buffered ahead of the position. */
  readonly bufferedAhead: LiveValue<number>;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const rung = rungOf(stream.mode);
  const bufferedAheadSeconds = useLiveValue(bufferedAhead, Math.round);

  return (
    <section
      aria-label="Stream info"
      className={cn(
        "on-media flex w-110 max-w-full flex-col gap-5 rounded-card border border-hairline bg-dark-surface-raised px-6 pt-5 pb-6 font-sans shadow-overlay",
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 className="text-body/body font-bold text-text">Stream info</h2>
        <button
          type="button"
          aria-label="Close stream info"
          onClick={onClose}
          className="flex size-6 cursor-pointer items-center justify-center rounded-bar text-text-muted transition-colors hover:text-text"
        >
          <XIcon className="size-5" strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      <ul className="flex gap-0.5 rounded-control bg-dark-bg p-0.75" aria-label="Playback mode">
        {RUNGS.map((each) => (
          <li
            key={each.id}
            aria-current={each.id === rung || undefined}
            className={cn(
              "flex h-7.5 grow basis-0 items-center justify-center rounded-inner font-mono text-caption/caption tracking-caps uppercase",
              each.id === rung
                ? cn(
                    "border border-hairline bg-dark-surface-raised font-semibold",
                    RUNG_TONES[rung],
                  )
                : "text-text-muted",
            )}
          >
            {each.label}
          </li>
        ))}
      </ul>
      <dl className="flex flex-col gap-1">
        {streamInfoRows(file, stream, bufferedAheadSeconds).map((row) => (
          <div key={row.label} className="flex gap-4 py-2">
            <dt className="w-21 shrink-0 text-label/5 text-text-muted">{row.label}</dt>
            <dd className="flex grow basis-0 flex-col gap-0.5">
              {row.lines.map((line, index) => (
                <span
                  key={line}
                  className={cn(
                    "font-mono text-label/5",
                    row.fromFirst === true && index === 0 ? "text-text-muted" : "text-text",
                  )}
                >
                  {line}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
