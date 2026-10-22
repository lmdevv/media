/**
 * The commands this person may run from Actions right now: filtered by their role, and by whether
 * anything is playing anywhere. Playing comes from the server's playback state, not this phone's
 * player, so a remote that controls another device still offers Pause and Skip.
 */
import { offeredCommands } from "@music/commands/forms";
import type { User } from "@music/commands/models";
import { useRead } from "@music/sdk/react";

import { useMe } from "@/components/settings/access";
import type { Action } from "@/lib/actions";

/** The signed-in account and the commands it may run; both undefined while they load. */
export const useOffered = ():
  | { readonly me: User; readonly offered: ReadonlyArray<Action> }
  | undefined => {
  const me = useMe();
  const position = useRead("playback.position", {});

  if (me === undefined || position === undefined) return undefined;

  return {
    me,
    offered: offeredCommands({ role: me.role, playing: position.activeDevice !== null }),
  };
};
