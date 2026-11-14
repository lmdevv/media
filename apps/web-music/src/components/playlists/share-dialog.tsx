import { usePlatform } from "@media/sdk/react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldHint } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { LinkIcon, PlusIcon } from "lucide-react";

import { useAction } from "@/lib/action";
import type { Playlist, PlaylistRole, PlaylistVisibility, UserId } from "@/lib/models";
import { useAllRows } from "@/lib/pages";
import { can } from "@/lib/permissions";
import { nameOf, useMe, useRead } from "@/lib/platform";
import type { Me } from "@/lib/platform";
import { useCopyLink } from "@/lib/use-copy-link";

const VISIBILITY_HINTS: Readonly<Record<PlaylistVisibility, string>> = {
  private: "Only you and the people below can open it.",
  shared: "Anyone signed in to this server who has the link can view and play it.",
};

const ROLE_LABELS: Readonly<Record<PlaylistRole, string>> = {
  viewer: "Can view",
  collaborator: "Can edit",
};

const ROLES: ReadonlyArray<PlaylistRole> = ["viewer", "collaborator"];

const PERSON_ROLES: Readonly<Record<Me["role"], string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/**
 * Sharing a playlist you own: who has the link (private, or anyone on the server), the people it
 * is shared with and whether each can edit, and a way to stop sharing at once. Sharing never
 * gives anyone access to your libraries: songs they can't listen to show as unavailable.
 */
export function ShareDialog({
  playlist,
  open,
  onOpenChange,
}: {
  readonly playlist: Playlist;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <ShareForm playlist={playlist} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function ShareForm({
  playlist,
  onDone,
}: {
  readonly playlist: Playlist;
  readonly onDone: () => void;
}) {
  const platform = usePlatform();
  const music = platform.music;
  const me = useMe();
  const sharing = useRead(music.playlists.sharing, { playlistId: playlist.id });
  const setVisibility = music.playlists.visibility;
  const share = music.playlists.share;
  const unshare = music.playlists.unshare;
  const copyLink = useCopyLink();

  const [changeVisibility, changing] = useAction(
    (visibility: PlaylistVisibility) => setVisibility({ playlistId: playlist.id, visibility }),
    { success: () => "Saved who can open it" },
  );

  const [add, adding] = useAction(
    (userId: UserId, role: PlaylistRole) => share({ playlistId: playlist.id, userId, role }),
    { success: () => "Shared" },
  );

  const [remove] = useAction((userId: UserId) => unshare({ playlistId: playlist.id, userId }));

  const [stop, stopping] = useAction(() => unshare({ playlistId: playlist.id }), {
    success: () => `Stopped sharing ${playlist.name}`,
  });

  const sharedIds = new Set<UserId>((sharing?.people ?? []).map((entry) => entry.person.id));
  const visibility = sharing?.visibility ?? playlist.visibility;
  const shared = visibility === "shared" || (sharing?.people.length ?? 0) > 0;

  return (
    <DialogContent title={`Share ${playlist.name}`}>
      <div className="flex flex-col gap-1.5">
        <span className="font-sans text-sm/xs font-medium text-text">Who has the link</span>
        <Segmented
          label="Who has the link"
          value={visibility}
          options={[
            { value: "private", label: "Only people added" },
            { value: "shared", label: "Anyone on this server" },
          ]}
          onChange={(next) =>
            next === visibility || changing ? undefined : void changeVisibility(next)
          }
          className="w-fit"
        />
        <FieldHint>{VISIBILITY_HINTS[visibility]}</FieldHint>
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-sans text-sm/xs font-medium text-text">People</span>
        {sharing === undefined ? (
          <Skeleton className="h-12 w-full rounded-md" />
        ) : (
          <ul aria-label="People it is shared with" className="flex flex-col">
            {sharing.people.length === 0 ? (
              <li className="py-2 font-sans text-sm/xs text-text-muted">Nobody added yet.</li>
            ) : null}
            {sharing.people.map((entry) => (
              <li
                key={entry.person.id}
                className="flex min-h-11 items-center gap-3 border-b border-border py-1.5"
              >
                <span className="min-w-0 grow truncate font-sans text-base/sm text-text">
                  {entry.person.name}
                </span>
                <div
                  role="group"
                  aria-label={`What ${entry.person.name} can do`}
                  className="flex gap-1.5"
                >
                  {ROLES.map((role) => (
                    <Chip
                      key={role}
                      selected={entry.role === role}
                      onClick={() =>
                        role === entry.role ? undefined : void add(entry.person.id, role)
                      }
                    >
                      {ROLE_LABELS[role]}
                    </Chip>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label={`Stop sharing with ${entry.person.name}`}
                  onClick={() => void remove(entry.person.id)}
                  className="font-sans text-sm/xs font-medium text-danger hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {me !== undefined && can(me.role, "admin") ? (
          <AddSomeone
            me={me.userId}
            shared={sharedIds}
            adding={adding}
            onAdd={(userId) => void add(userId, "viewer")}
          />
        ) : null}
        <FieldHint>
          Sharing doesn't open your libraries: songs someone can't listen to show as unavailable.
        </FieldHint>
      </div>
      <DialogFooter>
        {shared ? (
          <Button variant="danger" pending={stopping} onClick={() => void stop()}>
            Stop sharing
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => copyLink({ kind: "playlist", id: playlist.id })}>
          <LinkIcon />
          Copy link
        </Button>
        <Button variant="solid" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Picks someone to share with. Old music listed everyone on the server to members
 * (`people.directory`); the core lists users to admins alone (`core.accounts.users.list`), so
 * only admins pick people here until the core lists people to members.
 */
function AddSomeone({
  me,
  shared,
  adding,
  onAdd,
}: {
  readonly me: UserId;
  readonly shared: ReadonlySet<UserId>;
  readonly adding: boolean;
  readonly onAdd: (userId: UserId) => void;
}) {
  const platform = usePlatform();

  const users = useAllRows(platform.core.accounts.users.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const candidates = (users ?? []).filter((user) => user.userId !== me && !shared.has(user.userId));

  if (candidates.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="secondary" size="sm" className="w-fit" pending={adding} />}
      >
        <PlusIcon strokeWidth={2} />
        Add someone
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {candidates.map((user) => (
          <DropdownMenuItem key={user.userId} onClick={() => onAdd(user.userId)}>
            {nameOf(user)} · {PERSON_ROLES[user.role]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
