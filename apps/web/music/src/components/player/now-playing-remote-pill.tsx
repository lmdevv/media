import { usePlayer } from "@media/player/react";

import { cn } from "@/lib/utils";

import { playingElsewhere } from "./player-actions";

/**
 * "Playing on …" badge shown on Now Playing while another device or a Chromecast plays; renders
 * nothing while the music plays on this browser's own speakers.
 */
export function RemotePill({ className }: { readonly className?: string }) {
  const elsewhere = playingElsewhere(usePlayer());

  if (elsewhere === null) return null;

  const { Icon, name } = elsewhere;

  return (
    <output
      className={cn(
        "inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-accent px-3 font-sans text-sm/xs font-semibold text-on-accent",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      Playing on {name}
    </output>
  );
}
