import { PlayerButton, PlayerControls, TracksGlyph } from "@media/ui/components/player-controls";
import { TrackPopover } from "@media/ui/components/track-popover";
import type { TrackChoice, TrackOption } from "@media/ui/components/track-popover";
import { useState } from "react";

import { useFullscreen } from "@/components/player/use-player-frame";
import { QUALITY_OPTIONS } from "@/playback/quality";

const LABEL = "Audio, subtitles, and quality";

const VERSIONS: ReadonlyArray<TrackOption> = [
  {
    id: "uhd",
    label: "4K HDR10 Director's Cut",
    detail: "2160p · HEVC · HDR10 · TrueHD 7.1 · 61.4 GB",
  },
  { id: "hd", label: "1080p Theatrical", detail: "1080p · H.264 · AAC 2.0 · 4.2 GB" },
  { id: "sd", label: "DVD", detail: "480p · MPEG-2 · AC-3 2.0 · 3.9 GB" },
];

const AUDIO: ReadonlyArray<TrackOption> = [
  { id: "en", label: "English · Dolby TrueHD 7.1 Atmos" },
  { id: "en-commentary", label: "English · Commentary with the director and the cinematographer" },
  { id: "de", label: "Deutsch · Audiodeskription für Blinde und Sehbehinderte" },
  { id: "ja", label: "日本語 · ステレオ" },
];

const SUBTITLES: ReadonlyArray<TrackOption> = [
  { id: "off", label: "Off" },
  ...[
    "English",
    "English · SDH",
    "English · Forced",
    "Español (Latinoamérica)",
    "Español (España)",
    "Français",
    "Français (Canada)",
    "Deutsch",
    "Deutsch · Hörgeschädigte",
    "Italiano",
    "Português (Brasil)",
    "Português (Portugal)",
    "Nederlands",
    "Svenska",
    "Norsk bokmål",
    "Dansk",
    "Suomi",
    "Polski",
    "Čeština",
    "Magyar",
    "Română",
    "Ελληνικά",
    "Türkçe",
    "Українська",
    "Русский",
    "العربية",
    "עברית",
    "हिन्दी",
    "ไทย",
    "Bahasa Indonesia",
    "简体中文",
  ].map((label, index) => ({ id: `s${String(index)}`, label })),
];

const CHOSEN_SUBTITLE = SUBTITLES.find((option) => option.label === "Українська")?.id ?? "off";

/**
 * The player's track menu over a still frame, its trigger where the player has it, at the size of
 * the window. `columns` picks the choices: subtitles alone, audio, subtitles and quality, or those
 * with the version first.
 */
export function TrackMenuBench({ columns }: { readonly columns: "1" | "3" | "4" }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [version, setVersion] = useState("hd");
  const [audio, setAudio] = useState("en");
  const [subtitle, setSubtitle] = useState(CHOSEN_SUBTITLE);
  const [quality, setQuality] = useState("auto");
  const [overlays, setOverlays] = useState<HTMLDivElement | null>(null);
  const { toggle } = useFullscreen(frame, null);

  const subtitles: TrackChoice = {
    id: "subtitles",
    label: "Subtitles",
    options: [...SUBTITLES],
    value: subtitle,
    onValueChange: setSubtitle,
  };

  const choices: ReadonlyArray<TrackChoice> =
    columns === "1"
      ? [subtitles]
      : [
          ...(columns === "4"
            ? [
                {
                  id: "version",
                  label: "Version",
                  options: VERSIONS,
                  value: version,
                  onValueChange: setVersion,
                },
              ]
            : []),
          { id: "audio", label: "Audio", options: AUDIO, value: audio, onValueChange: setAudio },
          subtitles,
          {
            id: "quality",
            label: "Quality",
            options: QUALITY_OPTIONS,
            value: quality,
            onValueChange: setQuality,
          },
        ];

  return (
    <div ref={setFrame} data-testid="player" className="fixed inset-0 bg-dark-bg text-text">
      <PlayerControls
        className="absolute inset-x-0 bottom-0"
        title="Severance S2:E4 Woe's Hollow"
        playing={false}
        position={1882}
        duration={3480}
        onPlayPause={() => undefined}
        onSeek={() => undefined}
        onFullscreen={toggle}
        tracks={
          <TrackPopover
            trigger={
              <PlayerButton aria-label={LABEL}>
                <TracksGlyph />
              </PlayerButton>
            }
            container={overlays ?? undefined}
            label={LABEL}
            choices={choices}
          />
        }
      />
      <div ref={setOverlays} className="contents" />
    </div>
  );
}
