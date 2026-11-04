import type { LibraryId } from "@media/contracts/ids";
import type { CreatedInvite, Invite, User } from "@media/contracts/models/account";
import type { LibraryDetail } from "@media/contracts/models/catalog";
import type { AssignableRole } from "@media/contracts/scopes";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Avatar } from "@media/ui/components/avatar";
import { Button } from "@media/ui/components/button";
import { Checkbox } from "@media/ui/components/checkbox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@media/ui/components/dropdown-menu";
import { Skeleton } from "@media/ui/components/skeleton";
import { cn } from "@media/ui/lib/utils";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { useNow } from "@/lib/use-now";
import { useViewer } from "@/session/viewer";

import { useAction } from "./action";
import { CopyField } from "./copy-field";
import { formatDate, formatUntil } from "./format";
import { PageHeader } from "./page-header";
import { SelectField } from "./select-field";
import { Cell, Column, StatusDot, Table, TableHead, TableRow } from "./table";
import { QueryView } from "./query-view";

const ROLE_LABELS: Readonly<Record<User["role"], string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  service: "Media service",
};

const ROLE_OPTIONS: ReadonlyArray<{ readonly value: AssignableRole; readonly label: string }> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

const EXPIRY_OPTIONS = [
  { value: "1", label: "In 1 day · single use" },
  { value: "7", label: "In 7 days · single use" },
  { value: "14", label: "In 14 days · single use" },
  { value: "30", label: "In 30 days · single use" },
] as const;

type ExpiryOption = (typeof EXPIRY_OPTIONS)[number]["value"];

const itemClass = "h-9 rounded-control px-2.5 text-label/label text-text focus:bg-text/8";

/** Users and invites: accounts with their roles and library access, and invite links. */
export function UsersScreen() {
  const users = useCommandQuery("users.list", {});
  const libraries = useCommandQuery("libraries.listDetails", {});
  const viewer = useViewer();
  const now = useNow(30_000);
  const selfId = viewer?.user.id ?? null;
  const allLibraries = libraries.status === "success" ? libraries.data : [];

  return (
    <>
      <PageHeader title="Users" />
      <QueryView query={users} loading={<Skeleton className="h-36 w-full rounded-control" />}>
        {(list) => (
          <Table label="Users">
            <TableHead>
              <Column className="w-70">User</Column>
              <Column className="w-32">Role</Column>
              <Column className="w-25">Status</Column>
              <Column className="min-w-50 flex-1">Libraries</Column>
              <Column className="w-35">Joined</Column>
              <Column className="w-19" />
            </TableHead>
            {list
              .filter((user) => user.role !== "service")
              .map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  self={user.id === selfId}
                  libraries={allLibraries}
                  now={now}
                />
              ))}
          </Table>
        )}
      </QueryView>
      <div className="flex flex-col items-start gap-10 pt-10 md:flex-row md:gap-16">
        <NewInvite />
        <PendingInvites now={now} />
      </div>
    </>
  );
}

const libraryAccessLabel = (user: User, libraries: ReadonlyArray<LibraryDetail>): string => {
  if (user.role === "owner" || user.role === "admin") return "All libraries";

  const restricted = libraries.filter((library) => library.access === "restricted");
  const granted = restricted.filter((library) => library.grantedUserIds.includes(user.id));

  if (restricted.length === 0 || granted.length === restricted.length) return "All libraries";

  return granted.length === 0
    ? "Shared libraries"
    : `Shared + ${granted.map((library) => library.name).join(", ")}`;
};

function UserRow({
  user,
  self,
  libraries,
  now,
}: {
  readonly user: User;
  readonly self: boolean;
  readonly libraries: ReadonlyArray<LibraryDetail>;
  readonly now: number;
}) {
  const setRole = useCommand("users.setRole");
  const enable = useCommand("users.enable");
  const [dialog, setDialog] = useState<"access" | "disable" | null>(null);
  const changeable = !self && user.role !== "owner";
  const nextRole: AssignableRole = user.role === "admin" ? "member" : "admin";

  const roleChange = useAction(() => setRole({ userId: user.id, role: nextRole }), {
    success: () => `${user.name} is now ${nextRole === "admin" ? "an admin" : "a member"}`,
  });

  const reenable = useAction(() => enable({ userId: user.id }), {
    success: () => `${user.name} can sign in again`,
  });

  return (
    <TableRow className="h-12">
      <Cell className="flex w-70 items-center gap-2.5">
        <Avatar name={user.name} size="xs" monogram />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-sans text-label/label font-semibold text-text">
            {self ? `${user.name} (you)` : user.name}
          </span>
          <span className="truncate font-mono text-caption/caption text-text-muted">
            {user.email ?? "—"}
          </span>
        </span>
      </Cell>
      <Cell className="w-32 font-sans text-label/label text-text">{ROLE_LABELS[user.role]}</Cell>
      <Cell className="flex w-25 items-center gap-1.5">
        <StatusDot tone={user.disabled ? "danger" : "success"} />
        <span
          className={cn("font-sans text-label/label", user.disabled ? "text-danger" : "text-text")}
        >
          {user.disabled ? "Disabled" : "Active"}
        </span>
      </Cell>
      <Cell className="min-w-50 flex-1 truncate font-sans text-label/label text-text">
        {libraryAccessLabel(user, libraries)}
      </Cell>
      <Cell className="w-35 font-mono text-caption/caption text-text-muted">
        {formatDate(user.createdAt, now)}
      </Cell>
      <Cell className="flex w-19 justify-end">
        {changeable ? (
          <UserMenu
            user={user}
            nextRole={nextRole}
            onRoleChange={() => void roleChange.run()}
            onEnable={() => void reenable.run()}
            onDialog={setDialog}
          />
        ) : null}
      </Cell>
      {dialog === "access" ? (
        <LibraryAccessDialog onClose={() => setDialog(null)} user={user} libraries={libraries} />
      ) : null}
      {dialog === "disable" ? <DisableDialog onClose={() => setDialog(null)} user={user} /> : null}
    </TableRow>
  );
}

function UserMenu({
  user,
  nextRole,
  onRoleChange,
  onEnable,
  onDialog,
}: {
  readonly user: User;
  readonly nextRole: AssignableRole;
  readonly onRoleChange: () => void;
  readonly onEnable: () => void;
  readonly onDialog: (dialog: "access" | "disable") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Change ${user.name}`}
        className="flex size-8 cursor-pointer items-center justify-center rounded-control text-text-muted transition-colors hover:bg-text/8 hover:text-text"
      >
        <EllipsisIcon className="size-4" strokeWidth={2.5} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem className={itemClass} onClick={onRoleChange}>
          {nextRole === "admin" ? "Make admin" : "Make member"}
        </DropdownMenuItem>
        {user.role === "member" ? (
          <DropdownMenuItem className={itemClass} onClick={() => onDialog("access")}>
            Library access…
          </DropdownMenuItem>
        ) : null}
        {user.disabled ? (
          <DropdownMenuItem className={itemClass} onClick={onEnable}>
            Enable account
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            variant="destructive"
            className={cn(itemClass, "text-danger focus:bg-danger/10")}
            onClick={() => onDialog("disable")}
          >
            Disable account…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LibraryAccessDialog({
  onClose,
  user,
  libraries,
}: {
  readonly onClose: () => void;
  readonly user: User;
  readonly libraries: ReadonlyArray<LibraryDetail>;
}) {
  const setAccess = useCommand("users.setLibraryAccess");
  const restricted = libraries.filter((library) => library.access === "restricted");

  const [chosen, setChosen] = useState<ReadonlyArray<LibraryId>>(() =>
    restricted
      .filter((library) => library.grantedUserIds.includes(user.id))
      .map((library) => library.id),
  );

  const save = useAction(() => setAccess({ userId: user.id, libraryIds: chosen }), {
    success: () => `Saved ${user.name}’s libraries`,
    onSuccess: onClose,
  });

  return (
    <Dialog defaultOpen onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent title={`${user.name}’s libraries`} size="sm">
        <DialogBody className="gap-1">
          {restricted.length === 0 ? (
            <p className="font-sans text-body/body text-text-muted">
              Every library is shared with everyone.
            </p>
          ) : (
            restricted.map((library) => (
              <label key={library.id} className="flex h-10 cursor-pointer items-center gap-3">
                <Checkbox
                  checked={chosen.includes(library.id)}
                  onCheckedChange={(on) =>
                    setChosen((current) =>
                      on
                        ? [...current.filter((id) => id !== library.id), library.id]
                        : current.filter((id) => id !== library.id),
                    )
                  }
                />
                <span className="font-sans text-label/label text-text">{library.name}</span>
              </label>
            ))
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
          <Button
            size="dialog"
            disabled={save.pending || restricted.length === 0}
            onClick={() => void save.run()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({ onClose, user }: { readonly onClose: () => void; readonly user: User }) {
  const disable = useCommand("users.disable");

  const action = useAction(() => disable({ userId: user.id }), {
    success: () => `Disabled ${user.name}`,
    onSuccess: onClose,
  });

  return (
    <Dialog defaultOpen onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent title={`Disable ${user.name}?`} size="sm">
        <DialogBody>
          <p className="font-sans text-body/body text-text-muted">
            They are signed out everywhere, and their keys and devices stop working. Their profiles
            and history stay.
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            size="dialog"
            disabled={action.pending}
            onClick={() => void action.run()}
          >
            Disable account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewInvite() {
  const create = useCommand("invites.create");
  const [role, setRole] = useState<AssignableRole>("member");
  const [expiry, setExpiry] = useState<ExpiryOption>("7");
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const action = useAction(() => create({ role, expiresInDays: Number(expiry) }), {
    success: () => "Invite link ready",
    onSuccess: setCreated,
  });

  return (
    <section
      aria-labelledby="new-invite"
      className="flex w-full flex-col gap-5 md:w-115 md:shrink-0"
    >
      <h2
        id="new-invite"
        className="font-sans text-heading/heading font-bold tracking-tight text-text"
      >
        New invite
      </h2>
      <div className="flex gap-2.5">
        <SelectField
          label="Role"
          value={role}
          options={ROLE_OPTIONS}
          onChange={setRole}
          className="min-w-0 flex-1"
        />
        <SelectField
          label="Link expires"
          value={expiry}
          options={EXPIRY_OPTIONS}
          onChange={setExpiry}
          className="min-w-0 flex-1"
        />
      </div>
      {created === null ? (
        <div>
          <Button
            size="xs"
            className="font-semibold"
            disabled={action.pending}
            onClick={() => void action.run()}
          >
            Create invite link
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-label/label font-medium text-text-muted">
            Invite link
          </span>
          <CopyField value={created.url} label="Invite link" emphasis="accent" />
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="w-fit cursor-pointer pt-1 font-sans text-label/label font-semibold text-text-muted hover:text-text"
          >
            Create another
          </button>
        </div>
      )}
    </section>
  );
}

const inviteMeta = (invite: Invite, now: number): string =>
  [
    ROLE_LABELS[invite.role],
    invite.email === null ? "link" : null,
    `sent ${formatDate(invite.createdAt, now)}`,
    `expires ${formatUntil(invite.expiresAt, now)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

function PendingInvites({ now }: { readonly now: number }) {
  const invites = useCommandQuery("invites.list", {});

  const open =
    invites.status === "success" ? invites.data.filter((invite) => invite.state === "open") : [];

  return (
    <section aria-labelledby="pending-invites" className="flex w-full min-w-0 flex-1 flex-col">
      <h2
        id="pending-invites"
        className="pb-5 font-sans text-heading/heading font-bold tracking-tight text-text"
      >
        Pending invites
      </h2>
      {invites.status === "loading" ? (
        <Skeleton className="h-26 rounded-control" />
      ) : open.length === 0 ? (
        <p className="font-sans text-label/label text-text-muted">No open invites.</p>
      ) : (
        open.map((invite) => <PendingInvite key={invite.id} invite={invite} now={now} />)
      )}
    </section>
  );
}

function PendingInvite({ invite, now }: { readonly invite: Invite; readonly now: number }) {
  const revoke = useCommand("invites.revoke");

  const action = useAction(() => revoke({ inviteId: invite.id }), {
    success: () => "Invite revoked",
  });

  return (
    <div className="flex h-13 shrink-0 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-sans text-label/label font-semibold text-text">
          {invite.email ?? "Invite link"}
        </span>
        <span className="truncate font-mono text-caption/caption text-text-muted">
          {inviteMeta(invite, now)}
        </span>
      </div>
      <button
        type="button"
        disabled={action.pending}
        onClick={() => void action.run()}
        className="w-16 shrink-0 cursor-pointer text-right font-sans text-label/label font-semibold text-text-muted hover:text-danger"
      >
        Revoke
      </button>
    </div>
  );
}
