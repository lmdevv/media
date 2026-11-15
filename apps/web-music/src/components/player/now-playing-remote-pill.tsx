import { deviceKind } from "@media/player/connect-devices";
import { usePlayer } from "@media/player/react";

import { cn } from "@/lib/utils";

import { deviceIcon } from "./player-actions";

/** "Playing on …" badge shown on Now Playing while another device plays; renders nothing locally. */
export function RemotePill({ className }: { readonly className?: string }) {
  const { remote } = usePlayer();

  if (remote === null) return null;

  const Icon = deviceIcon(deviceKind(remote.name));

  return (
    <span
      role="status"
      className={cn(
        "inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-accent px-3 font-sans text-sm/xs font-semibold text-on-accent",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      Playing on {remote.name}
    </span>
  );
}
