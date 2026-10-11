import type { TrackId } from "@music/commands/ids";
import { usePlayer } from "@music/player/react";
import { useReadOnce, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Chip } from "@music/ui/components/chip";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import { FieldLabel, Input } from "@music/ui/components/input";
import { useNavigate } from "@tanstack/react-router";
import { Match } from "effect";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { useUi } from "@/components/shell/ui-state";
import { useAction } from "@/lib/action";
import { formatCount, plural } from "@/lib/format";

type StartWith = "nothing" | "selection" | "queue" | "liked";

/** The New playlist dialog from Paper (06 · 02): a name and what the playlist starts with. */
export function NewPlaylistDialog() {
  const { newPlaylist, closeNewPlaylist } = useUi();

  return (
    <Dialog
      open={newPlaylist !== null}
      onOpenChange={(open) => (open ? undefined : closeNewPlaylist())}
    >
      {newPlaylist === null ? null : (
        <NewPlaylistForm seed={newPlaylist.trackIds} onDone={closeNewPlaylist} />
      )}
    </Dialog>
  );
}

function NewPlaylistForm({
  seed,
  onDone,
}: {
  readonly seed: ReadonlyArray<TrackId>;
  readonly onDone: () => void;
}) {
  const navigate = useNavigate();
  const player = usePlayer();
  const create = useRun("playlists.create");
  const readLikes = useReadOnce("likes.list");
  const [name, setName] = useState("");
  const [startWith, setStartWith] = useState<StartWith>(seed.length > 0 ? "selection" : "nothing");

  useEffect(() => setStartWith(seed.length > 0 ? "selection" : "nothing"), [seed]);

  const [submit, pending] = useAction(
    async (): Promise<string> => {
      const trackIds: ReadonlyArray<TrackId> = await Match.value(startWith).pipe(
        Match.when("selection", () => Promise.resolve(seed)),
        Match.when("queue", () => Promise.resolve(player.queue.map((track) => track.id))),
        Match.when("liked", async () => (await readLikes({})).map((track) => track.id)),
        Match.when("nothing", () => Promise.resolve([])),
        Match.exhaustive,
      );

      const trimmed = name.trim();

      const { playlistId } = await create(
        trackIds.length === 0
          ? { name: trimmed }
          : { name: trimmed, trackIds: trackIds.slice(0, 2000) },
      );

      onDone();
      await navigate({ to: "/playlists/$playlistId", params: { playlistId } });

      return trimmed;
    },
    { success: (created) => `Created ${created}` },
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (name.trim().length > 0) void submit();
  };

  return (
    <DialogContent title="New playlist" description="Private to you. Sharing comes later.">
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-playlist-name">Name</FieldLabel>
          <Input
            id="new-playlist-name"
            required
            maxLength={120}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-sm/xs font-medium text-text">Start with</span>
          <div role="group" aria-label="Start with" className="flex flex-wrap gap-2">
            {seed.length > 0 ? (
              <Chip selected={startWith === "selection"} onClick={() => setStartWith("selection")}>
                {seed.length === 1 ? "This song" : `These songs · ${formatCount(seed.length)}`}
              </Chip>
            ) : null}
            <Chip selected={startWith === "nothing"} onClick={() => setStartWith("nothing")}>
              Nothing
            </Chip>
            <Chip
              selected={startWith === "queue"}
              disabled={player.queue.length === 0}
              onClick={() => setStartWith("queue")}
            >
              Current queue · {formatCount(player.queue.length)}
            </Chip>
            <Chip selected={startWith === "liked"} onClick={() => setStartWith("liked")}>
              Liked songs
            </Chip>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
          <Button
            type="submit"
            variant="solid"
            disabled={name.trim().length === 0}
            pending={pending}
          >
            {pending ? "Creating…" : "Create"}
            <span aria-hidden className="font-mono text-xs/xs opacity-(--opacity-muted)">
              ↵
            </span>
          </Button>
        </DialogFooter>
        <span className="sr-only">{plural(seed.length, "song")} selected</span>
      </form>
    </DialogContent>
  );
}
