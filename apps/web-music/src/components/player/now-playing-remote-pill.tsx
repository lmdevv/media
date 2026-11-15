import { usePlayer } from "@media/player/react";

import { deviceIcon, deviceKind } from "./player-actions";

/** "Playing on …" badge shown on Now Playing while another device plays; renders nothing locally. */
export function RemotePill() {
  const { remote } = usePlayer();

  if (remote === null) return null;

  const Icon = deviceIcon(deviceKind(remote.name));

  return (
    <span
      role="status"
      className="inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-accent px-3 font-sans text-sm/xs font-semibold text-on-accent"
    >
      <Icon aria-hidden className="size-3.5" />
      Playing on {remote.name}
    </span>
  );
}
