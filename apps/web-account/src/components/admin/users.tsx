import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { TextField } from "@media/ui/components/text-field";
import { Match } from "effect";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/shell";
import { describeFailure } from "@/lib/failure";
import { useMe } from "@/session/me";
import type { UserId } from "@/session/platform-types";

import { useActions } from "./action";
import { KidLimits } from "./kid-limits";
import { usePages } from "./pages";
import type { Paged } from "./pages";
import {
  Failed,
  ItemRow,
  Muted,
  Notice,
  OnceLink,
  PagedList,
  Section,
  SelectField,
  formatTime,
} from "./parts";
import type { Choice } from "./parts";
import type { AssignableRole, Invite, Restrictions, Role, User } from "./types";

const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

const ROLE_CHOICES: ReadonlyArray<Choice<AssignableRole>> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

type Expiry = "1" | "7" | "14" | "30";

const EXPIRY_CHOICES: ReadonlyArray<Choice<Expiry>> = [
  { value: "1", label: "In 1 day" },
  { value: "7", label: "In 7 days" },
  { value: "14", label: "In 14 days" },
  { value: "30", label: "In 30 days" },
];

/** A link the core made and shows only once. */
interface MadeLink {
  readonly url: string;
  readonly expiresAt: number;
}

/** Users: everyone with their role, each person's settings, and invites. */
export function UsersScreen() {
  const platform = usePlatform();
  const me = useMe();

  const users = usePages(platform.core.accounts.users.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const [open, setOpen] = useState<UserId | null>(null);

  return (
    <>
      <PageHeader title="Users" />
      <PeopleView
        users={users}
        selfId={me.userId}
        open={open}
        onToggle={(userId) => setOpen((current) => (current === userId ? null : userId))}
        panel={(user) => <UserPanel user={user} />}
      />
      <AddSomeone />
      <PendingInvites />
    </>
  );
}

/** The users list; the open person's settings show under their row. */
export function PeopleView({
  users,
  selfId,
  open,
  onToggle,
  panel,
}: {
  readonly users: Paged<User>;
  readonly selfId: UserId;
  readonly open: UserId | null;
  readonly onToggle: (userId: UserId) => void;
  readonly panel: (user: User) => ReactNode;
}) {
  return (
    <Section title="People">
      <PagedList label="People" list={users} empty="Nobody yet." rowKey={(user) => user.userId}>
        {(user) => (
          <ItemRow
            title={user.userId === selfId ? `${user.username} (you)` : user.username}
            facts={ROLE_LABELS[user.role]}
            actions={
              user.role === "guest" ? null : (
                <Button
                  variant="raised"
                  size="row"
                  aria-expanded={open === user.userId}
                  aria-label={`Manage ${user.username}`}
                  onClick={() => onToggle(user.userId)}
                >
                  {open === user.userId ? "Close" : "Manage"}
                </Button>
              )
            }
          >
            {open === user.userId ? panel(user) : null}
          </ItemRow>
        )}
      </PagedList>
    </Section>
  );
}

type UserAction =
  | "role"
  | "handOver"
  | "reset"
  | "lock"
  | "unlock"
  | "list"
  | "unlist"
  | "allowGuests"
  | "stopGuests";

/** A step that asks first, because it signs someone out or cannot be undone by this admin. */
type Confirm = "handOver" | "stopGuests";

/** What the panel knows about the person's limits. Only a member can have them. */
type LimitsState =
  | { readonly kind: "notMember" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string; readonly retry: () => void }
  | { readonly kind: "ready"; readonly saved: Restrictions | null };

function UserPanel({ user }: { readonly user: User }) {
  return user.role === "member" ? (
    <MemberPanel user={user} />
  ) : (
    <PanelActions user={user} limits={{ kind: "notMember" }} limitsForm={() => null} />
  );
}

/** A member's panel, which also reads their limits and the libraries to limit them to. */
function MemberPanel({ user }: { readonly user: User }) {
  const platform = usePlatform();
  const restrictions = usePlatformQuery(platform.core.restrictions.get, { userId: user.userId });

  const libraries = usePages(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const limits = Match.value(restrictions).pipe(
    Match.discriminatorsExhaustive("status")({
      loading: (): LimitsState => ({ kind: "loading" }),
      error: ({ error, retry }): LimitsState => ({
        kind: "failed",
        message: describeFailure(error),
        retry,
      }),
      success: ({ data }): LimitsState => ({ kind: "ready", saved: data }),
    }),
  );

  return (
    <PanelActions
      user={user}
      limits={limits}
      limitsForm={(saved) => (
        <KidLimits
          key={JSON.stringify(saved)}
          userId={user.userId}
          saved={saved}
          libraries={libraries}
        />
      )}
    />
  );
}

function PanelActions({
  user,
  limits,
  limitsForm,
}: {
  readonly user: User;
  readonly limits: LimitsState;
  readonly limitsForm: (saved: Restrictions | null) => ReactNode;
}) {
  const platform = usePlatform();
  const me = useMe();
  const actions = useActions<UserAction>();
  const [reset, setReset] = useState<MadeLink | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const { userId, username } = user;
  const tiles = platform.core.devices.tiles;

  const handOver = async (): Promise<void> => {
    const done = await actions.run(
      "handOver",
      () => platform.core.accounts.users.handOverOwnership({ userId }),
      `${username} owns this server now`,
    );

    if (done !== undefined) setConfirm(null);
  };

  const makeReset = async (): Promise<void> => {
    const made = await actions.run("reset", () =>
      platform.core.accounts.resetLinks.create({ userId }),
    );

    if (made !== undefined) {
      setReset({ url: `${location.origin}/reset/${made.code}`, expiresAt: made.expiresAt });
    }
  };

  const allowGuests = async (allowed: boolean): Promise<void> => {
    const done = await actions.run(
      allowed ? "allowGuests" : "stopGuests",
      () => platform.core.guests.allow({ userId, allowed }),
      allowed ? `${username} can make guest links` : `${username} can't make guest links`,
    );

    if (done !== undefined) setConfirm(null);
  };

  return (
    <UserPanelView
      user={user}
      self={user.userId === me.userId}
      viewerIsOwner={me.role === "owner"}
      running={actions.running}
      reset={reset}
      confirm={confirm}
      limits={limits}
      limitsForm={limitsForm}
      onConfirm={setConfirm}
      onRole={(role) =>
        void actions.run(
          "role",
          () => platform.core.accounts.users.setRole({ userId, role }),
          `${username} is now ${role === "admin" ? "an admin" : "a member"}`,
        )
      }
      onHandOver={() => void handOver()}
      onReset={() => void makeReset()}
      onResetDone={() => setReset(null)}
      onLock={(locked) =>
        void actions.run(
          locked ? "lock" : "unlock",
          () => tiles.setLock({ userId, locked }),
          locked
            ? `${username}'s tile now asks for a proof`
            : `${username}'s tile no longer needs a lock from you`,
        )
      }
      onListed={(listed) =>
        void actions.run(
          listed ? "list" : "unlist",
          () => tiles.setListed({ userId, listed }),
          listed ? `${username} is on shared devices` : `${username} is off shared devices`,
        )
      }
      onGuests={(allowed) => void allowGuests(allowed)}
    />
  );
}

/** Everything an admin can change about one person. */
export interface UserPanelViewProps {
  readonly user: User;
  readonly self: boolean;
  readonly viewerIsOwner: boolean;
  readonly running: UserAction | null;
  readonly reset: MadeLink | null;
  readonly confirm: Confirm | null;
  readonly limits: LimitsState;
  readonly limitsForm: (saved: Restrictions | null) => ReactNode;
  readonly onConfirm: (confirm: Confirm | null) => void;
  readonly onRole: (role: AssignableRole) => void;
  readonly onHandOver: () => void;
  readonly onReset: () => void;
  readonly onResetDone: () => void;
  readonly onLock: (locked: boolean) => void;
  readonly onListed: (listed: boolean) => void;
  readonly onGuests: (allowed: boolean) => void;
}

/**
 * One person's settings: role and ownership, a password reset link, kid limits, their tile on
 * shared devices, and guest links. The core does not say whether a tile lock is on, whether a kid
 * is listed, or whether a member may make guest links, so each is a pair of actions.
 */
export function UserPanelView({
  user,
  self,
  viewerIsOwner,
  running,
  reset,
  confirm,
  limits,
  limitsForm,
  onConfirm,
  onRole,
  onHandOver,
  onReset,
  onResetDone,
  onLock,
  onListed,
  onGuests,
}: UserPanelViewProps) {
  const busy = running !== null;
  const changeable = !self && user.role !== "owner";
  const kid = limits.kind === "ready" && limits.saved !== null;

  return (
    <div className="flex flex-col gap-6 rounded-card bg-surface-raised px-4 py-5 md:px-5">
      {changeable ? (
        <Part title="Role">
          <div className="flex flex-wrap gap-2">
            {user.role === "admin" ? (
              <Button variant="raised" size="xs" disabled={busy} onClick={() => onRole("member")}>
                Make member
              </Button>
            ) : (
              <Button
                variant="raised"
                size="xs"
                disabled={busy || kid}
                onClick={() => onRole("admin")}
              >
                Make admin
              </Button>
            )}
            {viewerIsOwner ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy || kid}
                onClick={() => onConfirm("handOver")}
              >
                Hand over ownership
              </Button>
            ) : null}
          </div>
          {user.role === "admin" ? (
            <Muted>Making them a member signs them out everywhere.</Muted>
          ) : null}
          {kid ? <Muted>Lift their limits before making them an admin or the owner.</Muted> : null}
          {confirm === "handOver" ? (
            <Notice
              action={
                <div className="flex gap-2">
                  <Button variant="ghost" size="xs" disabled={busy} onClick={() => onConfirm(null)}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={busy} onClick={onHandOver}>
                    Hand over
                  </Button>
                </div>
              }
            >
              {`${user.username} becomes the owner. You stay an admin.`}
            </Notice>
          ) : null}
        </Part>
      ) : null}
      {changeable ? (
        <Part title="Password">
          {reset === null ? (
            <div>
              <Button variant="raised" size="xs" disabled={busy} onClick={onReset}>
                Make a reset link
              </Button>
            </div>
          ) : (
            <OnceLink
              label="Reset link"
              url={reset.url}
              expiresAt={reset.expiresAt}
              onDone={onResetDone}
            />
          )}
        </Part>
      ) : null}
      {limits.kind === "notMember" || self ? null : (
        <Part title="Kid limits">
          {limits.kind === "loading" ? <Muted>Loading…</Muted> : null}
          {limits.kind === "failed" ? (
            <Failed message={limits.message} retry={limits.retry} />
          ) : null}
          {limits.kind === "ready" ? limitsForm(limits.saved) : null}
        </Part>
      )}
      <Part title="Shared devices">
        <div className="flex flex-wrap gap-2">
          <Button variant="raised" size="xs" disabled={busy} onClick={() => onLock(true)}>
            Require a tile lock
          </Button>
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => onLock(false)}>
            Stop requiring a lock
          </Button>
        </div>
        {kid ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="raised" size="xs" disabled={busy} onClick={() => onListed(true)}>
              List on shared devices
            </Button>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => onListed(false)}>
              Take off shared devices
            </Button>
          </div>
        ) : null}
      </Part>
      {user.role === "member" && !self ? (
        <Part title="Guest links">
          <div className="flex flex-wrap gap-2">
            <Button variant="raised" size="xs" disabled={busy} onClick={() => onGuests(true)}>
              Allow guest links
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => onConfirm("stopGuests")}
            >
              Stop guest links
            </Button>
          </div>
          {confirm === "stopGuests" ? (
            <Notice
              action={
                <div className="flex gap-2">
                  <Button variant="ghost" size="xs" disabled={busy} onClick={() => onConfirm(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="xs"
                    disabled={busy}
                    onClick={() => onGuests(false)}
                  >
                    Stop
                  </Button>
                </div>
              }
            >
              {`${user.username} is signed out, and every guest link they made stops working.`}
            </Notice>
          ) : null}
        </Part>
      ) : null}
    </div>
  );
}

function Part({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-sans text-label/label font-semibold text-text">{title}</h3>
      {children}
    </div>
  );
}

function AddSomeone() {
  const platform = usePlatform();
  const actions = useActions<"invite" | "create">();
  const [inviteRole, setInviteRole] = useState<AssignableRole>("member");
  const [expiry, setExpiry] = useState<Expiry>("7");
  const [invite, setInvite] = useState<MadeLink | null>(null);
  const [account, setAccount] = useState<NewAccount>(EMPTY_ACCOUNT);

  const makeInvite = async (): Promise<void> => {
    const made = await actions.run("invite", () =>
      platform.core.accounts.invites.create({ role: inviteRole, expiresInDays: Number(expiry) }),
    );

    if (made !== undefined) {
      setInvite({ url: `${location.origin}/invite/${made.code}`, expiresAt: made.expiresAt });
    }
  };

  const create = async (): Promise<void> => {
    const username = account.username.trim();

    const made = await actions.run(
      "create",
      () =>
        platform.core.accounts.users.create({
          username,
          password: account.password,
          role: account.role,
        }),
      `Created ${username}`,
    );

    if (made !== undefined) setAccount(EMPTY_ACCOUNT);
  };

  return (
    <AddSomeoneView
      invite={{ role: inviteRole, expiry, made: invite }}
      account={account}
      running={actions.running}
      onInviteRole={setInviteRole}
      onExpiry={setExpiry}
      onInvite={() => void makeInvite()}
      onInviteDone={() => setInvite(null)}
      onAccount={setAccount}
      onCreate={() => void create()}
    />
  );
}

/** An account an admin is making with a password they choose. */
export interface NewAccount {
  readonly username: string;
  readonly password: string;
  readonly role: AssignableRole;
}

const EMPTY_ACCOUNT: NewAccount = { username: "", password: "", role: "member" };

/** The invite form, or the link it made. */
export interface InviteDraft {
  readonly role: AssignableRole;
  readonly expiry: Expiry;
  readonly made: MadeLink | null;
}

/** Inviting someone with a link, or making their account with a password. */
export function AddSomeoneView({
  invite,
  account,
  running,
  onInviteRole,
  onExpiry,
  onInvite,
  onInviteDone,
  onAccount,
  onCreate,
}: {
  readonly invite: InviteDraft;
  readonly account: NewAccount;
  readonly running: "invite" | "create" | null;
  readonly onInviteRole: (role: AssignableRole) => void;
  readonly onExpiry: (expiry: Expiry) => void;
  readonly onInvite: () => void;
  readonly onInviteDone: () => void;
  readonly onAccount: (account: NewAccount) => void;
  readonly onCreate: () => void;
}) {
  const busy = running !== null;
  const ready = account.username.trim() !== "" && account.password !== "";

  return (
    <div className="grid gap-10 md:grid-cols-2 md:gap-12">
      <Section title="Invite someone">
        {invite.made === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-3">
              <SelectField
                label="Role"
                value={invite.role}
                options={ROLE_CHOICES}
                onChange={onInviteRole}
                className="min-w-36 flex-1"
              />
              <SelectField
                label="Link expires"
                value={invite.expiry}
                options={EXPIRY_CHOICES}
                onChange={onExpiry}
                className="min-w-36 flex-1"
              />
            </div>
            <div>
              <Button size="xs" disabled={busy} onClick={onInvite}>
                Create invite link
              </Button>
            </div>
          </div>
        ) : (
          <OnceLink
            label="Invite link"
            url={invite.made.url}
            expiresAt={invite.made.expiresAt}
            onDone={onInviteDone}
          />
        )}
      </Section>
      <Section title="Create an account">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();

            if (ready) onCreate();
          }}
        >
          <TextField
            label="Username"
            autoComplete="off"
            value={account.username}
            onChange={(event) => onAccount({ ...account, username: event.target.value })}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            value={account.password}
            onChange={(event) => onAccount({ ...account, password: event.target.value })}
          />
          <SelectField
            label="Role"
            value={account.role}
            options={ROLE_CHOICES}
            onChange={(role) => onAccount({ ...account, role })}
          />
          <div>
            <Button type="submit" size="xs" disabled={busy || !ready}>
              Create account
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}

function PendingInvites() {
  const platform = usePlatform();

  const invites = usePages(platform.core.accounts.invites.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const actions = useActions<Invite["inviteId"]>();

  return (
    <PendingInvitesView
      invites={invites}
      revoking={actions.running}
      onRevoke={(inviteId) =>
        void actions.run(
          inviteId,
          () => platform.core.accounts.invites.revoke({ inviteId }),
          "Invite revoked",
        )
      }
    />
  );
}

/** The invites that still work, each with Revoke. */
export function PendingInvitesView({
  invites,
  revoking,
  onRevoke,
}: {
  readonly invites: Paged<Invite>;
  readonly revoking: Invite["inviteId"] | null;
  readonly onRevoke: (inviteId: Invite["inviteId"]) => void;
}) {
  return (
    <Section title="Pending invites">
      <PagedList
        label="Pending invites"
        list={invites}
        empty="No open invites."
        rowKey={(invite) => invite.inviteId}
      >
        {(invite) => (
          <ItemRow
            title={`${ROLE_LABELS[invite.role]} invite`}
            facts={`by ${invite.invitedBy} · expires ${formatTime(invite.expiresAt)}`}
            actions={
              <Button
                variant="ghost"
                size="row"
                disabled={revoking !== null}
                onClick={() => onRevoke(invite.inviteId)}
              >
                Revoke
              </Button>
            }
          />
        )}
      </PagedList>
    </Section>
  );
}
