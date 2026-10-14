import type { Invite, Role } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Chip } from "@music/ui/components/chip";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { AdminOnly, SettingsHeader } from "@/components/settings/settings-ui";
import { toastFailure, useAction } from "@/lib/action";
import { formatAgo, formatUntil, initial } from "@/lib/format";

export const Route = createFileRoute("/_app/settings/people")({ component: PeopleSettings });

/** The shareable sign-up link for an invite code. */
const inviteLink = (code: string): string => `${window.location.origin}/invite/${code}`;

const copyLink = (code: string): void => {
  navigator.clipboard
    .writeText(inviteLink(code))
    .then(() => toast.success("Copied the invite link"))
    .catch(() => toast.error(`Couldn't copy. The link is ${inviteLink(code)}`));
};

function PeopleSettings() {
  const me = useRead("account.me", {});

  if (me === undefined) return <Skeleton className="h-40 w-full rounded-lg" />;

  if (me.role !== "admin") return <AdminOnly />;

  return <People myId={me.id} />;
}

const rowClassName = "flex h-16 shrink-0 items-center gap-3.5 border-b border-border px-3";

function People({ myId }: { readonly myId: string }) {
  const people = useRead("people.list", {});
  const invites = useRead("invites.list", {});
  const [inviting, setInviting] = useState(false);

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
          {people.map((person) => {
            const you = person.id === myId;

            return (
              <div role="listitem" key={person.id} className={rowClassName}>
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full font-sans text-sm/xs font-semibold",
                    you ? "bg-text text-text-inverse" : "bg-surface text-text",
                  )}
                >
                  {initial(person.name ?? person.email)}
                </span>
                <span className="flex min-w-0 grow flex-col gap-px">
                  <span className="truncate font-sans text-base/sm font-medium text-text">
                    {person.name ?? person.email}
                    {you ? " (you)" : ""}
                  </span>
                  <span className="truncate font-sans text-sm/xs text-text-muted">
                    {person.email}
                  </span>
                </span>
                <span className="w-30 shrink-0 font-mono text-xs/xs tracking-mono text-text-muted uppercase">
                  {person.role}
                </span>
                <span className="hidden w-35 shrink-0 md:block" />
                <span className="w-15 shrink-0" />
              </div>
            );
          })}
          {invites.map((invite) => (
            <InviteRow key={invite.id} invite={invite} />
          ))}
        </div>
      )}
      <p className="w-fit rounded-md bg-surface px-3.5 py-3 font-sans text-sm/xs text-text">
        Sign-up is closed. People can only join with an invite link.
      </p>
      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </div>
  );
}

function InviteRow({ invite }: { readonly invite: Invite }) {
  const revoke = useRun("invites.revoke");
  const [pending, setPending] = useState(false);

  const cancel = () => {
    setPending(true);
    revoke({ inviteId: invite.id })
      .then(() => toast.success("Cancelled the invite"))
      .catch(toastFailure)
      .finally(() => setPending(false));
  };

  return (
    <div role="listitem" className={rowClassName}>
      <span
        aria-hidden
        className="size-9 shrink-0 rounded-full border-field border-dashed border-border"
      />
      <span className="flex min-w-0 grow flex-col gap-px">
        <span className="truncate font-sans text-base/sm font-medium text-text">
          {invite.email ?? "Anyone with the link"}
        </span>
        <span className="truncate font-sans text-sm/xs text-text-muted">
          Invite sent {formatAgo(invite.createdAt)} · expires {formatUntil(invite.expiresAt)}
        </span>
      </span>
      <span className="w-30 shrink-0 font-mono text-xs/xs tracking-mono text-text-muted">
        PENDING
      </span>
      <span className="hidden w-35 shrink-0 md:block">
        <button
          type="button"
          onClick={() => copyLink(invite.code)}
          className="font-sans text-sm/xs font-medium text-text hover:underline"
        >
          Copy link
        </button>
      </span>
      <span className="flex w-15 shrink-0 justify-end">
        <button
          type="button"
          disabled={pending}
          onClick={cancel}
          className="font-sans text-sm/xs font-medium text-danger hover:underline disabled:opacity-(--opacity-muted)"
        >
          {pending ? "…" : "Cancel"}
        </button>
      </span>
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const create = useRun("invites.create");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [created, setCreated] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);

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
      setCopied(false);
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
              <div role="group" aria-label="Role" className="flex gap-2">
                <Chip selected={role === "member"} onClick={() => setRole("member")}>
                  Member
                </Chip>
                <Chip selected={role === "admin"} onClick={() => setRole("admin")}>
                  Admin
                </Chip>
              </div>
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
          <div className="flex h-12 items-center gap-2.5 rounded-sm bg-surface pr-1.5 pl-3.5">
            <code
              data-testid="invite-link"
              className="min-w-0 grow truncate font-mono text-sm/xs text-text select-all"
            >
              {inviteLink(created.code)}
            </code>
            <Button
              variant="solid"
              size="sm"
              className="h-9 rounded-sm px-3"
              onClick={() =>
                void navigator.clipboard.writeText(inviteLink(created.code)).then(
                  () => setCopied(true),
                  () => toast.error("Couldn't copy. Select the link and copy it yourself."),
                )
              }
            >
              {copied ? <CheckIcon strokeWidth={2} /> : <CopyIcon />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
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
