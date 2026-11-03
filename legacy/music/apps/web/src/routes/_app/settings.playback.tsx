import { usePlayer } from "@music/player/react";
import type { StreamQuality } from "@music/player/stream-quality";
import { Keys } from "@music/ui/components/keys";
import { Segmented } from "@music/ui/components/segmented";
import { useAppHotkeyList } from "@tanstack/react-hotkeys";
import { createFileRoute } from "@tanstack/react-router";
import { useTheme } from "next-themes";

import { SettingsHeader } from "@/components/settings/settings-ui";
import { GLOBAL_GROUP } from "@/lib/hotkeys";

export const Route = createFileRoute("/_app/settings/playback")({ component: PlaybackSettings });

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

type ThemeChoice = (typeof THEMES)[number]["value"];

const QUALITIES = [
  { value: "lossless", label: "Lossless" },
  { value: "high", label: "High" },
  { value: "data-saver", label: "Data saver" },
] as const satisfies ReadonlyArray<{ value: StreamQuality; label: string }>;

const QUALITY_NOTES: Record<StreamQuality, string> = {
  lossless: "FLAC for lossless files, gapless where the browser supports it.",
  high: "AAC 256 kbps, gapless where the browser supports it.",
  "data-saver": "AAC 128 kbps for slow or metered connections.",
};

const toChoice = (theme: string | undefined): ThemeChoice =>
  THEMES.find((option) => option.value === theme)?.value ?? "system";

function PlaybackSettings() {
  const { theme, setTheme } = useTheme();
  const { quality, setQuality, engine } = usePlayer();

  const shortcuts = useAppHotkeyList().filter(
    ({ appHotkey }) => appHotkey.meta?.group === GLOBAL_GROUP,
  );

  return (
    <div className="flex max-w-180 flex-col gap-7">
      <SettingsHeader
        title="Playback"
        lead="Applies to this browser. Each device remembers its own choice."
      />
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
        <div className="flex flex-col gap-0.5">
          <span className="font-sans text-base/sm font-semibold text-text">Appearance</span>
          <span className="font-sans text-sm/xs text-text-muted">
            Now Playing always uses the album's colors.
          </span>
        </div>
        <Segmented
          label="Appearance"
          value={toChoice(theme)}
          options={THEMES}
          onChange={setTheme}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
        <div className="flex flex-col gap-0.5">
          <span className="font-sans text-base/sm font-semibold text-text">Streaming quality</span>
          <span className="font-sans text-sm/xs text-text-muted">
            {QUALITY_NOTES[quality]} Applies from the next song.
          </span>
          <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">
            {engine === "mse" ? "Gapless engine" : "Standard engine"}
          </span>
        </div>
        <Segmented
          label="Streaming quality"
          value={quality}
          options={QUALITIES}
          onChange={setQuality}
        />
      </div>
      <div className="flex flex-col gap-3">
        <span className="font-sans text-base/sm font-semibold text-text">Keyboard shortcuts</span>
        <dl className="flex flex-col">
          {shortcuts.map(({ appHotkey }) => (
            <div
              key={appHotkey.id}
              className="flex h-row items-center justify-between gap-4 border-b border-border"
            >
              <dt className="font-sans text-base/sm text-text">{appHotkey.meta?.name}</dt>
              <dd>{appHotkey.hotkey === null ? null : <Keys hotkey={appHotkey.hotkey} />}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
