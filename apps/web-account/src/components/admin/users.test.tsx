import { Brand } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { UserId } from "@/session/platform-types";

import type { Paged } from "./pages";
import { loaded, noop, textOf } from "./testing";
import { AddSomeoneView, PeopleView, PendingInvitesView, UserPanelView } from "./users";
import type { UserPanelViewProps } from "./users";
import type { Invite, User } from "./types";

const userId = Brand.nominal<UserId>();

const inviteId = Brand.nominal<Invite["inviteId"]>();

const ada: User = { userId: userId("u1"), username: "ada", role: "owner" };

const kid: User = { userId: userId("u2"), username: "sam", role: "member" };

const bo: User = { userId: userId("u3"), username: "bo", role: "admin" };

const guest: User = { userId: userId("u4"), username: "Visitor", role: "guest" };

/** The users list with each person's panel drawn as a line naming them. */
const people = (users: Paged<User>, open: UserId | null = null) =>
  textOf(
    <PeopleView
      users={users}
      selfId={ada.userId}
      open={open}
      onToggle={noop}
      panel={(user) => <p>{`panel of ${user.username}`}</p>}
    />,
  );

/** The add-someone part with an invite made or not, and the account form's fields. */
const addSomeone = (
  made: { url: string; expiresAt: number } | null,
  username = "",
  password = "",
) =>
  renderToStaticMarkup(
    <AddSomeoneView
      invite={{ role: "member", expiry: "7", made }}
      account={{ username, password, role: "member" }}
      running={null}
      onInviteRole={noop}
      onExpiry={noop}
      onInvite={noop}
      onInviteDone={noop}
      onAccount={noop}
      onCreate={noop}
    />,
  );

describe("PeopleView", () => {
  it("shows a loading skeleton, then a failure with Try again", () => {
    expect(
      renderToStaticMarkup(
        <PeopleView
          users={{ status: "loading" }}
          selfId={ada.userId}
          open={null}
          onToggle={noop}
          panel={() => null}
        />,
      ),
    ).toContain('aria-label="Loading People"');
    expect(people({ status: "failed", message: "Can't reach the server.", retry: noop })).toContain(
      "Can't reach the server. Try again",
    );
  });

  it("lists everyone with their role, marks you, and offers Manage to all but guests", () => {
    const text = people(loaded([ada, kid, guest]));

    expect(text).toContain("ada (you) Owner");
    expect(text).toContain("sam Member Manage");
    expect(text).toContain("Visitor Guest");
    expect(text).not.toContain("Visitor Guest Manage");
  });

  it("shows Load more while pages remain, and the open person's panel", () => {
    const text = people(loaded([ada, kid], true), kid.userId);

    expect(text).toContain("Load more");
    expect(text).toContain("panel of sam");
    expect(text).not.toContain("panel of ada");
  });
});

describe("UserPanelView", () => {
  const props: UserPanelViewProps = {
    user: kid,
    self: false,
    viewerIsOwner: false,
    running: null,
    reset: null,
    confirm: null,
    limits: { kind: "ready", saved: null },
    limitsForm: (saved) => (
      <p>{saved === null ? "limits form, none saved" : "limits form, saved"}</p>
    ),
    onConfirm: noop,
    onRole: noop,
    onHandOver: noop,
    onReset: noop,
    onResetDone: noop,
    onLock: noop,
    onListed: noop,
    onGuests: noop,
  };

  it("offers a member every setting, and listing only once they are a kid", () => {
    const adult = textOf(<UserPanelView {...props} />);

    expect(adult).toContain("Make admin");
    expect(adult).toContain("Make a reset link");
    expect(adult).toContain("limits form, none saved");
    expect(adult).toContain("Require a tile lock");
    expect(adult).toContain("Allow guest links");
    expect(adult).not.toContain("List on shared devices");

    const restricted = textOf(
      <UserPanelView
        {...props}
        limits={{
          kind: "ready",
          saved: { maxMovieAge: 7, hideUnrated: true, hideExplicitMusic: true, libraries: null },
        }}
      />,
    );

    expect(restricted).toContain("List on shared devices");
    expect(restricted).toContain("Lift their limits before making them an admin or the owner.");
  });

  it("disables Make admin for a kid", () => {
    const markup = renderToStaticMarkup(
      <UserPanelView
        {...props}
        limits={{
          kind: "ready",
          saved: {
            maxMovieAge: null,
            hideUnrated: true,
            hideExplicitMusic: false,
            libraries: null,
          },
        }}
      />,
    );

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Make admin<\/button>/u);
  });

  it("shows the limits loading and failing", () => {
    expect(textOf(<UserPanelView {...props} limits={{ kind: "loading" }} />)).toContain(
      "Kid limits Loading…",
    );
    expect(
      textOf(
        <UserPanelView
          {...props}
          limits={{ kind: "failed", message: "Forbidden here", retry: noop }}
        />,
      ),
    ).toContain("Forbidden here Try again");
  });

  it("gives an admin Make member, and no limits or guest-link part", () => {
    const text = textOf(<UserPanelView {...props} user={bo} limits={{ kind: "notMember" }} />);

    expect(text).toContain("Make member");
    expect(text).toContain("Making them a member signs them out everywhere.");
    expect(text).not.toContain("Kid limits");
    expect(text).not.toContain("Allow guest links");
  });

  it("offers the handover only to the owner, and asks first", () => {
    expect(textOf(<UserPanelView {...props} />)).not.toContain("Hand over ownership");

    const asking = textOf(<UserPanelView {...props} user={bo} viewerIsOwner confirm="handOver" />);

    expect(asking).toContain("bo becomes the owner. You stay an admin. Cancel Hand over");
  });

  it("leaves the owner's role and password alone", () => {
    const text = textOf(<UserPanelView {...props} user={ada} limits={{ kind: "notMember" }} />);

    expect(text).not.toContain("Role");
    expect(text).not.toContain("Make a reset link");
    expect(text).toContain("Require a tile lock");
  });

  it("shows a reset link once with Copy", () => {
    const text = textOf(
      <UserPanelView {...props} reset={{ url: "https://media.test/reset/abc", expiresAt: 0 }} />,
    );

    expect(text).toContain("Reset link https://media.test/reset/abc Copy");
    expect(text).toContain("It shows only this once.");
    expect(text).not.toContain("Make a reset link");
  });

  it("asks before stopping someone's guest links", () => {
    expect(textOf(<UserPanelView {...props} confirm="stopGuests" />)).toContain(
      "sam is signed out, and every guest link they made stops working.",
    );
  });

  it("disables every action while one runs", () => {
    const markup = renderToStaticMarkup(<UserPanelView {...props} running="lock" />);

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Require a tile lock<\/button>/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Make a reset link<\/button>/u);
  });
});

describe("AddSomeoneView", () => {
  it("offers an invite link and a new account, which needs a name and a password", () => {
    expect(addSomeone(null)).toContain("Create invite link");
    expect(addSomeone(null)).toMatch(/<button[^>]*disabled=""[^>]*>Create account<\/button>/u);
    expect(addSomeone(null, "kim", "a long password")).not.toMatch(
      /disabled=""[^>]*>Create account/u,
    );
  });

  it("shows the invite link once it is made", () => {
    const markup = addSomeone({ url: "https://media.test/invite/xyz", expiresAt: 0 });

    expect(markup).toContain("https://media.test/invite/xyz");
    expect(markup).not.toContain("Create invite link");
  });
});

describe("PendingInvitesView", () => {
  it("says when nothing is open, and lists the invites with Revoke", () => {
    const empty = textOf(
      <PendingInvitesView invites={loaded([])} revoking={null} onRevoke={noop} />,
    );

    expect(empty).toContain("No open invites.");

    const invite: Invite = {
      inviteId: inviteId("i1"),
      role: "admin",
      invitedBy: "ada",
      expiresAt: 0,
    };

    const text = textOf(
      <PendingInvitesView invites={loaded([invite])} revoking={null} onRevoke={noop} />,
    );

    expect(text).toContain("Admin invite");
    expect(text).toContain("by ada");
    expect(text).toContain("Revoke");
  });
});
