import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { UserId } from "@/session/platform-types";

import { GroupPanelView, GroupsView } from "./groups";
import type { GroupMode } from "./groups";
import type { Paged } from "./pages";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { Group, Member, User } from "./types";

const groupId = Brand.nominal<Group["groupId"]>();

const userId = Brand.nominal<UserId>();

const kids: Group = { groupId: groupId("g1"), name: "Kids" };

const sam: User = { userId: userId("u1"), username: "sam", role: "member" };

const kim: User = { userId: userId("u2"), username: "kim", role: "member" };

const groups = (list: Paged<Group>, name = "", open: Group["groupId"] | null = null) => (
  <GroupsView
    groups={list}
    name={name}
    creating={false}
    open={open}
    onName={noop}
    onCreate={noop}
    onToggle={noop}
    panel={(group) => <p>{`panel of ${group.name}`}</p>}
  />
);

const panel = (
  mode: GroupMode,
  members: Paged<Member> = loaded([sam]),
  adding: UserId | "" = "",
) => (
  <GroupPanelView
    group={kids}
    members={members}
    users={loaded([sam, kim])}
    mode={mode}
    adding={adding}
    running={null}
    onMode={noop}
    onAdding={noop}
    onRename={noop}
    onRemove={noop}
    onAdd={noop}
    onDrop={noop}
  />
);

describe("GroupsView", () => {
  it("says when there are no groups, and needs a name to create one", () => {
    expect(textOf(groups(loaded([])))).toContain("No groups yet.");
    expect(disabledButton(groups(loaded([])), "Create")).toBe(true);
    expect(disabledButton(groups(loaded([]), "Family"), "Create")).toBe(false);
  });

  it("lists the groups and opens one's panel", () => {
    const text = textOf(groups(loaded([kids]), "", kids.groupId));

    expect(text).toContain("Kids Close");
    expect(text).toContain("panel of Kids");
  });

  it("shows a failure with Try again", () => {
    expect(textOf(groups({ status: "failed", message: "No access", retry: noop }))).toContain(
      "No access Try again",
    );
  });
});

describe("GroupPanelView", () => {
  it("lists members and offers only people outside the group", () => {
    const text = textOf(panel({ kind: "idle" }));

    expect(text).toContain("sam Take out");
    expect(text).toContain("Choose a person kim");
    expect(text).not.toContain("Choose a person sam");
    expect(disabledButton(panel({ kind: "idle" }), "Add")).toBe(true);
    expect(disabledButton(panel({ kind: "idle" }, loaded([sam]), kim.userId), "Add")).toBe(false);
  });

  it("says when the group is empty", () => {
    expect(textOf(panel({ kind: "idle" }, loaded([])))).toContain("Nobody is in this group.");
  });

  it("renames in place", () => {
    const text = textOf(panel({ kind: "renaming", name: "Little ones" }));

    expect(text).toContain("Save Cancel");
    expect(text).not.toContain("Rename");
  });

  it("asks before removing", () => {
    expect(textOf(panel({ kind: "removing" }))).toContain(
      "What was shared with Kids stops reaching its members. Cancel Remove",
    );
  });
});
