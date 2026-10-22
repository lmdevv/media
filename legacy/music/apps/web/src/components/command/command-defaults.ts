import type { FieldSpec, FormValues } from "@music/commands/forms";
import type { MutationName } from "@music/commands/registry";
import { usePlayer } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { Match } from "effect";

import { NEXT_REPEAT } from "@/components/player/player-actions";

/**
 * A command form's default values from what is playing and on screen. Only the open command's
 * preview calls it. `positionMs` is the live playback position, which only the seek form passes
 * (it ticks several times a second); other forms pass null and don't follow it.
 */
export const useCommandDefaults = (
  name: MutationName,
  fields: ReadonlyArray<FieldSpec>,
  positionMs: number | null,
): FormValues => {
  const player = usePlayer();
  const me = useRead("account.me", {});
  const libraries = useRead("libraries.list", {});
  const values: Record<string, FormValues[string]> = {};

  for (const field of fields) {
    if (field.field.kind === "boolean" && !field.optional) values[field.name] = false;
  }

  const track = player.track;

  const extra: FormValues = Match.value(name).pipe(
    Match.when("likes.set", () =>
      track === null ? {} : { trackId: track.id, liked: !track.liked },
    ),
    Match.when("playback.shuffle", () => ({ on: !player.shuffle })),
    Match.when("playback.repeat", () => ({ mode: NEXT_REPEAT[player.repeat] })),
    Match.when("playback.volume", () => ({ volume: String(player.volume) })),
    Match.when("playback.seek", () =>
      positionMs === null ? {} : { positionMs: String(Math.round(positionMs)) },
    ),
    Match.when("playback.jump", () => ({ index: String(player.index) })),
    Match.when("account.rename", () => ({ name: me?.name ?? undefined })),
    // With one folder there is nothing to choose; removing one is left to an explicit pick.
    Match.when("libraries.scan", () =>
      libraries?.length === 1 && libraries[0] !== undefined ? { libraryId: libraries[0].id } : {},
    ),
    Match.whenOr("queue.add", "playback.play", "playlists.add", () =>
      track === null ? {} : { trackIds: [track.id] },
    ),
    Match.orElse(() => ({})),
  );

  return { ...values, ...extra };
};
