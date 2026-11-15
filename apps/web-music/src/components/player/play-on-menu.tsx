import { usePlayer } from "@media/player/react";
import type { MusicItem } from "@media/player/react";
import { toast } from "sonner";

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

import { deviceIcon, deviceKind } from "./player-actions";

/**
 * "Play on" in an album's menu: plays the album on another of your devices, which takes playback
 * over, as old music's play command with a device did from the album screen.
 */
export function PlayOnMenu({ item }: { readonly item: MusicItem }) {
  const { devices, playOn } = usePlayer();

  const play = async (deviceId: string) => {
    if (!(await playOn(deviceId, item))) toast.error("Couldn't play it there. Try again.");
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={devices.length === 0}>Play on</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {devices.map((device) => {
          const Icon = deviceIcon(deviceKind(device.name));

          return (
            <DropdownMenuItem
              key={device.id}
              className="h-row"
              onClick={() => void play(device.id)}
            >
              <Icon aria-hidden />
              <span className="grow truncate">{device.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
