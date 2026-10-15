import type { AssignableRole, Invite, Person, User } from "@music/commands/models";
import {
  assignableRoles,
  can,
  canManagePerson,
  canTransferOwnership,
  roleLabel,
} from "@music/commands/permissions";
import { useRead, useRun } from "@music/sdk/react";
import { Badge } from "@music/ui/components/badge";
import { Button } from "@music/ui/components/button";
import { Chip } from "@music/ui/components/chip";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@music/ui/components/dropdown-menu";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Skeleton } from "@music/ui/components/skeleton";
import { Switch } from "@music/ui/components/switch";
import { cn } from "@music/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import {
  AdminOnly,
  SecretLink,
  SettingsHeader,
  TerminalHint,
} from "@/components/settings/settings-ui";
import { useAction } from "@/lib/action";
import { formatAgo, formatUntil, initial } from "@/lib/format";
import { useNow } from "@/lib/use-now";

export const Route = createFileRoute("/_app/settings/people")({ component: PeopleSettings });

/** The shareable sign-up link for an invite code. */
const inviteLink = (code: string): string => `${window.location.origin}/invite/${code}`;

/** The one-time link that lets someone choose a new password. */
const resetLink = (token: string): string => `${window.location.origin}/reset/${token}`;

const copyLink = (link: string, what: string): void => {
  navigator.clipboard
    .writeText(link)
    .then(() => toast.success(`Copied the ${what} link`))
    .catch(() => toast.error(`Couldn't copy. The link is ${link}`));
};

/** What each role means, shown where a role is picked. */
const ROLE_HINTS: Readonly<Record<AssignableRole, string>> = {
  admin: "Runs the server: people, invites, libraries, and scans.",
  member: "Listens, and keeps their own playlists, likes, and API keys.",
  guest: "Listens only to the libraries you add them to. No API keys.",
};

function PeopleSettings() {
  const me = useRead("account.me", {});

  if (me === undefined) return <Skeleton className="h-40 w-full rounded-lg" />;

  if (!can(me.role, "admin")) return <AdminOnly />;

  return <People me={me} />;
}

const rowClassName =
  "flex min-h-16 shrink-0 items-center gap-3.5 border-b border-border px-3 py-2.5";

/** A change to one person that needs a dialog. */
type PersonAction = {
  readonly kind: "role" | "suspend" | "reset" | "remove" | "transfer";
  readonly person: Person;
} | null;

function People({ me }: { readonly me: User }) {
  const people = useRead("people.list", {});
  const invites = useRead("invites.list", {});
  const [inviting, setInviting] = useState(false);
  const [action, setAction] = useState<PersonAction>(null);
  const owner = people?.find((person) => person.role === "owner");

  return (
    <div className="flex flex-col gap-6">
      <SettingsHeader
        title="People"
        lead="Everyone gets their own playlists, likes, history and devices."
        action={
          <Button variant="solid" className="pr-4.5 pl-3.5" onClick={() => setInviting(true)}>
            <PlusIcon strokeWidth={2} />
            Invite
          </Button>
        }
      />
      {people === undefined || invites === undefined ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : (
        <div role="list" aria-label="People and invites" className="flex flex-col">
          {people.map((person) => (
            <PersonRow key={person.id} me={me} person={person} onAction={setAction} />
          ))}
          {invites.map((invite) => (
            <InviteRow key={invite.id} invite={invite} />
          ))}
        </div>
      )}
      <SignUpSettings />
      <TerminalHint label="From a terminal" command="music people list · music people --help" />
      <InviteDialog role={me.role} open={inviting} onOpenChange={setInviting} />
      <PersonDialog
        me={me}
        action={action}
        ownerName={owner === undefined ? "the owner" : (owner.name ?? owner.email)}
        onClose={() => setAction(null)}
      />
    </div>
  );
}

/**
 * How people get accounts: invites always; and, when an admin turns it on, Jam links, which make
 * guest accounts that hear only the Jam. Such guests are marked "joined via Jam" above.
 */
function SignUpSettings() {
  const settings = useRead("server.settings", {});
  const update = useRun("server.update");

  const [save, saving] = useAction((jamGuestAccounts: boolean) => update({ jamGuestAccounts }), {
    success: () => "Saved",
  });

  return (
    <div className="flex flex-col gap-3 rounded-md bg-surface px-3.5 py-3">
      <label className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="font-sans text-sm/xs font-medium text-text">
            Jam links can create guest accounts
          </span>
          <span className="font-sans text-sm/xs text-text-muted">
            Someone without an account can join a Jam as a guest with a name and password. They hear
            only the Jam, and the account goes when the Jam ends unless you change their role.
          </span>
        </span>
        <Switch
          checked={settings?.jamGuestAccounts ?? false}
          disabled={settings === undefined || saving}
          onCheckedChange={(on) => void save(on)}
        />
      </label>
      <span className="font-sans text-sm/xs text-text">
        {settings?.jamGuestAccounts === true
          ? "Otherwise, people join with an invite link."
          : "Sign-up is closed. People can only join with an invite link."}
      </span>
    </div>
  );
}

function PersonRow({
  me,
  person,
  onAction,
}: {
  readonly me: User;
  readonly person: Person;
  readonly onAction: (action: PersonAction) => void;
}) {
  const you = person.id === me.id;

  const active =
    person.lastActiveAt === null ? "Not active yet" : `Active ${formatAgo(person.lastActiveAt)}`;

  return (
    <div role="listitem" aria-label={person.name ?? person.email} className={rowClassName}>
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full font-sans text-sm/xs font-semibold",
          you ? "bg-text text-text-inverse" : "bg-surface text-text",
          person.suspended && "opacity-(--opacity-muted)",
        )}
      >
        {initial(person.name ?? person.email)}
      </span>
      <span className="flex min-w-0 grow flex-col gap-px">
        <span className="truncate font-sans text-base/sm font-medium text-text">
          {person.name ?? person.email}
          {you ? " (you)" : ""}
        </span>
        <span className="truncate font-sans text-sm/xs text-text-muted">{person.email}</span>
        <span className="truncate font-sans text-sm/xs text-text-muted md:hidden">
          {person.suspended ? "Suspended · " : ""}
          {active}
        </span>
      </span>
      <span className="flex w-45 shrink-0 flex-wrap items-center gap-1.5 max-md:w-auto">
        <Badge tone={person.role === "owner" ? "accent" : "surface"}>
          {person.joinedViaJam
            ? `${roleLabel(person.role)} · joined via Jam`
            : roleLabel(person.role)}
        </Badge>
        {person.suspended ? (
          <Badge tone="outline" className="max-md:hidden">
            Suspended
          </Badge>
        ) : null}
      </span>
      <span className="hidden w-35 shrink-0 font-sans text-sm/xs text-text-muted md:block">
        {active}
      </span>
      <span className="flex w-15 shrink-0 justify-end max-md:w-8">
        <PersonMenu me={me} person={person} onAction={onAction} />
      </span>
    </div>
  );
}

/** What the viewer may do to one person; nothing renders when that is nothing. */
function PersonMenu({
  me,
  person,
  onAction,
}: {
  readonly me: User;
  readonly person: Person;
  readonly onAction: (action: PersonAction) => void;
}) {
  const manageable = canManagePerson(me, person);
  const transferable = canTransferOwnership(me, person);
  const unsuspend = useRun("people.unsuspend");

  const [restore, restoring] = useAction(() => unsuspend({ userId: person.id }), {
    success: () => `${person.name ?? person.email} can sign in again`,
  });

  if (!manageable && !transferable) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${person.name ?? person.email}`}
        className="flex size-8 items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text"
      >
        <MoreHorizontalIcon className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {manageable ? (
          <>
            <DropdownMenuItem onClick={() => onAction({ kind: "role", person })}>
              Change role…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction({ kind: "reset", person })}>
              Create password reset link…
            </DropdownMenuItem>
            {person.suspended ? (
              <DropdownMenuItem disabled={restoring} onClick={() => void restore()}>
                Unsuspend
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onAction({ kind: "suspend", person })}>
                Suspend…
              </DropdownMenuItem>
            )}
          </>
        ) : null}
        {transferable ? (
          <DropdownMenuItem onClick={() => onAction({ kind: "transfer", person })}>
            Make owner…
          </DropdownMenuItem>
        ) : null}
        {manageable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" onClick={() => onAction({ kind: "remove", person })}>
              Remove from server…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The dialog for whichever change to a person is open. */
function PersonDialog({
  me,
  action,
  ownerName,
  onClose,
}: {
  readonly me: User;
  readonly action: PersonAction;
  readonly ownerName: string;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={action !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {action === null ? null : action.kind === "role" ? (
        <RoleForm key={action.person.id} me={me} person={action.person} onDone={onClose} />
      ) : action.kind === "reset" ? (
        <ResetForm key={action.person.id} person={action.person} onDone={onClose} />
      ) : (
        <ConfirmForm
          key={`${action.kind}-${action.person.id}`}
          kind={action.kind}
          person={action.person}
          ownerName={me.role === "owner" ? "you" : ownerName}
          onDone={onClose}
        />
      )}
    </Dialog>
  );
}

function RoleForm({
  me,
  person,
  onDone,
}: {
  readonly me: User;
  readonly person: Person;
  readonly onDone: () => void;
}) {
  const change = useRun("people.role");
  const roles = assignableRoles(me.role);
  const [role, setRole] = useState<AssignableRole>(person.role === "owner" ? "admin" : person.role);
  const name = person.name ?? person.email;

  const [save, saving] = useAction(
    async () => {
      await change({ userId: person.id, role });
      onDone();
    },
    { success: () => `${name} is now ${roleLabel(role).toLowerCase()}` },
  );

  return (
    <DialogContent title={`Change ${name}'s role`} description={ROLE_HINTS[role]}>
      <div role="group" aria-label="Role" className="flex flex-wrap gap-2">
        {roles.map((option) => (
          <Chip key={option} selected={role === option} onClick={() => setRole(option)}>
            {roleLabel(option)}
          </Chip>
        ))}
      </div>
      {role === "guest" && person.role !== "guest" ? (
        <FieldHint>
          Their API keys stop working, and they only hear libraries you add them to.
        </FieldHint>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button
          variant="solid"
          disabled={role === person.role}
          pending={saving}
          onClick={() => void save()}
        >
          Save role
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ResetForm({ person, onDone }: { readonly person: Person; readonly onDone: () => void }) {
  const create = useRun("people.reset");

  const [link, setLink] = useState<{ readonly url: string; readonly expiresAt: number } | null>(
    null,
  );

  const name = person.name ?? person.email;

  const [submit, pending] = useAction(async () => {
    const reset = await create({ userId: person.id });
    setLink({ url: resetLink(reset.token), expiresAt: reset.expiresAt });
  });

  if (link === null) {
    return (
      <DialogContent
        title={`Reset ${name}'s password?`}
        description="You get a link to send them. It works once, lasts 24 hours, and replaces any earlier link. Choosing a new password signs them out everywhere else. Signing in with the new password also turns off this person's API keys."
      >
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button variant="solid" pending={pending} onClick={() => void submit()}>
            Create link
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent
      title="Share the reset link"
      description={`Send it to ${name} privately. It expires ${formatUntil(link.expiresAt)}.`}
    >
      <SecretLink link={link.url} testId="reset-link" />
      <DialogFooter>
        <Button variant="solid" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** What each confirmed change says and does. */
const CONFIRM = {
  suspend: {
    title: (name: string) => `Suspend ${name}?`,
    description: () =>
      "They're signed out everywhere right away and can't sign in, and their API keys stop working. Their playlists and likes stay. You can unsuspend them any time.",
    button: "Suspend",
    tone: "danger",
    done: (name: string) => `Suspended ${name}`,
  },
  remove: {
    title: (name: string) => `Remove ${name} from the server?`,
    description: (owner: string) =>
      `They're signed out everywhere and can't sign in again. Their playlists, likes, listening history, devices, and API keys are deleted. Library folders they added, private ones too, move to ${owner}; no files change. This can't be undone, but you can invite them again.`,
    button: "Remove",
    tone: "danger",
    done: (name: string) => `Removed ${name}`,
  },
  transfer: {
    title: (name: string) => `Make ${name} the owner?`,
    description: () =>
      "There is one owner. They can do everything and can't be removed; you become an admin. Only they can give it back.",
    button: "Make owner",
    tone: "solid",
    done: (name: string) => `${name} is now the owner`,
  },
} as const;

function ConfirmForm({
  kind,
  person,
  ownerName,
  onDone,
}: {
  readonly kind: keyof typeof CONFIRM;
  readonly person: Person;
  readonly ownerName: string;
  readonly onDone: () => void;
}) {
  const suspend = useRun("people.suspend");
  const remove = useRun("people.remove");
  const transfer = useRun("people.transfer");
  const copy = CONFIRM[kind];
  const name = person.name ?? person.email;
  const run = { suspend, remove, transfer }[kind];

  const [confirm, pending] = useAction(
    async () => {
      await run({ userId: person.id });
      onDone();
    },
    { success: () => copy.done(name) },
  );

  return (
    <DialogContent title={copy.title(name)} description={copy.description(ownerName)}>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button variant={copy.tone} pending={pending} onClick={() => void confirm()}>
          {copy.button}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function InviteRow({ invite }: { readonly invite: Invite }) {
  const revoke = useRun("invites.revoke");
  // The server's status is as of the last change to the list; the clock moves on without one.
  const now = useNow(60_000);
  const expired = invite.status === "expired" || invite.expiresAt <= now;

  const [cancel, pending] = useAction(() => revoke({ inviteId: invite.id }), {
    success: () => (expired ? "Removed the expired invite" : "Cancelled the invite"),
  });

  return (
    <div
      role="listitem"
      aria-label={`Invite for ${invite.email ?? "anyone with the link"}`}
      className={rowClassName}
    >
      <span
        aria-hidden
        className="size-9 shrink-0 rounded-full border-field border-dashed border-border"
      />
      <span className="flex min-w-0 grow flex-col gap-px">
        <span
          className={cn(
            "truncate font-sans text-base/sm font-medium",
            expired ? "text-text-muted" : "text-text",
          )}
        >
          {invite.email ?? "Anyone with the link"}
        </span>
        <span className="truncate font-sans text-sm/xs text-text-muted">
          {roleLabel(invite.role)} · sent {formatAgo(invite.createdAt)} ·{" "}
          {expired
            ? `expired ${formatAgo(invite.expiresAt)}`
            : `expires ${formatUntil(invite.expiresAt)}`}
        </span>
      </span>
      <span className="flex w-45 shrink-0 items-center max-md:w-auto">
        {expired ? (
          <Badge tone="outline" className="text-danger">
            Expired
          </Badge>
        ) : (
          <Badge tone="outline">Pending</Badge>
        )}
      </span>
      <span className="hidden w-35 shrink-0 md:block">
        {expired ? null : (
          <button
            type="button"
            onClick={() => copyLink(inviteLink(invite.code), "invite")}
            className="font-sans text-sm/xs font-medium text-text hover:underline"
          >
            Copy link
          </button>
        )}
      </span>
      <span className="flex w-15 shrink-0 justify-end">
        <button
          type="button"
          disabled={pending}
          onClick={() => void cancel()}
          className="font-sans text-sm/xs font-medium text-danger hover:underline disabled:opacity-(--opacity-muted)"
        >
          {pending ? "…" : expired ? "Remove" : "Cancel"}
        </button>
      </span>
    </div>
  );
}

function InviteDialog({
  role: myRole,
  open,
  onOpenChange,
}: {
  readonly role: User["role"];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const create = useRun("invites.create");
  const roles = assignableRoles(myRole);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [created, setCreated] = useState<Invite | null>(null);

  const [submit, pending] = useAction(async () => {
    const trimmed = email.trim();
    const invite = await create(trimmed.length === 0 ? { role } : { email: trimmed, role });
    setCreated(invite);
  });

  const close = (next: boolean) => {
    onOpenChange(next);

    if (!next) {
      setCreated(null);
      setEmail("");
      setRole("member");
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      {created === null ? (
        <DialogContent
          title="Invite someone"
          description="They get their own playlists and likes. Invites last 7 days."
        >
          <form className="flex flex-col gap-6" onSubmit={onSubmit}>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="invite-email">Email (optional)</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <FieldHint>With an email, only that person can use the link.</FieldHint>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-sans text-sm/xs font-medium text-text">Role</span>
              <div role="group" aria-label="Role" className="flex flex-wrap gap-2">
                {roles.map((option) => (
                  <Chip key={option} selected={role === option} onClick={() => setRole(option)}>
                    {roleLabel(option)}
                  </Chip>
                ))}
              </div>
              <FieldHint>{ROLE_HINTS[role]}</FieldHint>
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
              <Button type="submit" variant="solid" pending={pending}>
                Create invite
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : (
        <DialogContent
          title="Share the invite link"
          description={`It works once and expires ${formatUntil(created.expiresAt)}.`}
        >
          <SecretLink link={inviteLink(created.code)} testId="invite-link" />
          <DialogFooter>
            <Button variant="solid" onClick={() => close(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
