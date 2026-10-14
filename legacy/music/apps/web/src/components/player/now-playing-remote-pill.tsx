import { usePlayer } from "@music/player/react";

import { deviceIcon, useIsRemote } from "./controls";

/** "Playing on …" badge shown on Now Playing while another device plays; renders nothing locally. */
export function RemotePill() {
  const player = usePlayer();
  const remote = useIsRemote();

  if (!remote || player.activeDevice === null) return null;

  const Icon = deviceIcon(player.activeDevice.kind);

  return (
    <span
      role="status"
      className="inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-accent px-3 font-sans text-sm/xs font-semibold text-on-accent"
    >
      <Icon aria-hidden className="size-3.5" />
      Playing on {player.activeDevice.name}
    </span>
  );
}
