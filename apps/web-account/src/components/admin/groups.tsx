import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { TextField } from "@media/ui/components/text-field";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/shell";
import type { UserId } from "@/session/platform-types";

import { useActions } from "./action";
import { usePages } from "./pages";
import type { Paged } from "./pages";
import { ItemRow, Muted, Notice, PagedList, SelectField } from "./parts";
import type { Group, Member, User } from "./types";

type GroupId = Group["groupId"];

/** Groups: create one, then rename it, remove it, or change its members. */
export function GroupsScreen() {
  const platform = usePlatform();

  const groups = usePages(platform.core.permissions.groups.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const actions = useActions<"create">();
  const [name, setName] = useState("");
  const [open, setOpen] = useState<GroupId | null>(null);

  const create = async (): Promise<void> => {
    const trimmed = name.trim();

    const made = await actions.run(
      "create",
      () => platform.core.permissions.groups.create({ name: trimmed }),
      `Created ${trimmed}`,
    );

    if (made !== undefined) setName("");
  };

  return (
    <GroupsView
      groups={groups}
      name={name}
      creating={actions.running === "create"}
      open={open}
      onName={setName}
      onCreate={() => void create()}
      onToggle={(groupId) => setOpen((current) => (current === groupId ? null : groupId))}
      panel={(group) => <GroupPanel group={group} />}
    />
  );
}

/** The groups list with a create form; the open group's panel shows under its row. */
export function GroupsView({
  groups,
  name,
  creating,
  open,
  onName,
  onCreate,
  onToggle,
  panel,
}: {
  readonly groups: Paged<Group>;
  readonly name: string;
  readonly creating: boolean;
  readonly open: GroupId | null;
  readonly onName: (name: string) => void;
  readonly onCreate: () => void;
  readonly onToggle: (groupId: GroupId) => void;
  readonly panel: (group: Group) => ReactNode;
}) {
  return (
    <>
      <PageHeader title="Groups" />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();

          if (name.trim() !== "") onCreate();
        }}
      >
        <TextField
          label="New group"
          value={name}
          onChange={(event) => onName(event.target.value)}
          className="min-w-0 flex-1 basis-56"
        />
        <Button type="submit" size="md" disabled={creating || name.trim() === ""}>
          Create
        </Button>
      </form>
      <PagedList
        label="Groups"
        list={groups}
        empty="No groups yet."
        rowKey={(group) => group.groupId}
      >
        {(group) => (
          <ItemRow
            title={group.name}
            actions={
              <Button
                variant="raised"
                size="row"
                aria-expanded={open === group.groupId}
                aria-label={`Manage ${group.name}`}
                onClick={() => onToggle(group.groupId)}
              >
                {open === group.groupId ? "Close" : "Manage"}
              </Button>
            }
          >
            {open === group.groupId ? panel(group) : null}
          </ItemRow>
        )}
      </PagedList>
    </>
  );
}

/** What the open group's panel is doing besides listing members. */
export type GroupMode =
  | { readonly kind: "idle" }
  | { readonly kind: "renaming"; readonly name: string }
  | { readonly kind: "removing" };

type GroupAction = "rename" | "remove" | "add" | "drop";

function GroupPanel({ group }: { readonly group: Group }) {
  const platform = usePlatform();
  const groups = platform.core.permissions.groups;
  const { groupId } = group;
  const members = usePages(groups.members, (paginationOpts) => ({ groupId, paginationOpts }));

  const users = usePages(platform.core.accounts.users.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const actions = useActions<GroupAction>();
  const [mode, setMode] = useState<GroupMode>({ kind: "idle" });
  const [adding, setAdding] = useState<UserId | "">("");

  const rename = async (name: string): Promise<void> => {
    const done = await actions.run(
      "rename",
      () => groups.rename({ groupId, name: name.trim() }),
      "Group renamed",
    );

    if (done !== undefined) setMode({ kind: "idle" });
  };

  const add = async (userId: UserId): Promise<void> => {
    const done = await actions.run(
      "add",
      () => groups.addMember({ groupId, userId }),
      "Added to the group",
    );

    if (done !== undefined) setAdding("");
  };

  return (
    <GroupPanelView
      group={group}
      members={members}
      users={users}
      mode={mode}
      adding={adding}
      running={actions.running}
      onMode={setMode}
      onAdding={setAdding}
      onRename={(name) => void rename(name)}
      onRemove={() =>
        void actions.run("remove", () => groups.remove({ groupId }), `Removed ${group.name}`)
      }
      onAdd={(userId) => void add(userId)}
      onDrop={(userId) =>
        void actions.run(
          "drop",
          () => groups.removeMember({ groupId, userId }),
          "Taken out of the group",
        )
      }
    />
  );
}

/** One group: rename, remove, its members, and adding someone from the users list. */
export function GroupPanelView({
  group,
  members,
  users,
  mode,
  adding,
  running,
  onMode,
  onAdding,
  onRename,
  onRemove,
  onAdd,
  onDrop,
}: {
  readonly group: Group;
  readonly members: Paged<Member>;
  readonly users: Paged<User>;
  readonly mode: GroupMode;
  readonly adding: UserId | "";
  readonly running: GroupAction | null;
  readonly onMode: (mode: GroupMode) => void;
  readonly onAdding: (userId: UserId | "") => void;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
  readonly onAdd: (userId: UserId) => void;
  readonly onDrop: (userId: UserId) => void;
}) {
  const busy = running !== null;

  const inGroup = new Set(
    members.status === "ready" ? members.rows.map((member) => member.userId) : [],
  );

  const candidates =
    users.status === "ready"
      ? users.rows.filter((user) => user.role !== "guest" && !inGroup.has(user.userId))
      : [];

  return (
    <div className="flex flex-col gap-5 rounded-card bg-surface-raised px-4 py-5 md:px-5">
      {mode.kind === "renaming" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();

            if (mode.name.trim() !== "") onRename(mode.name);
          }}
        >
          <TextField
            label="Name"
            value={mode.name}
            onChange={(event) => onMode({ kind: "renaming", name: event.target.value })}
            className="min-w-0 flex-1 basis-48"
          />
          <Button type="submit" size="md" disabled={busy || mode.name.trim() === ""}>
            Save
          </Button>
          <Button variant="ghost" size="md" onClick={() => onMode({ kind: "idle" })}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="raised"
            size="xs"
            disabled={busy}
            onClick={() => onMode({ kind: "renaming", name: group.name })}
          >
            Rename
          </Button>
          <Button
            variant="destructive"
            size="xs"
            disabled={busy}
            onClick={() => onMode({ kind: "removing" })}
          >
            Remove group
          </Button>
        </div>
      )}
      {mode.kind === "removing" ? (
        <Notice
          action={
            <div className="flex gap-2">
              <Button variant="ghost" size="xs" onClick={() => onMode({ kind: "idle" })}>
                Cancel
              </Button>
              <Button variant="destructive" size="xs" disabled={busy} onClick={onRemove}>
                Remove
              </Button>
            </div>
          }
        >
          {`What was shared with ${group.name} stops reaching its members.`}
        </Notice>
      ) : null}
      <div className="flex flex-col gap-2">
        <h3 className="font-sans text-label/label font-semibold text-text">Members</h3>
        <PagedList
          label={`Members of ${group.name}`}
          list={members}
          empty="Nobody is in this group."
          rowKey={(member) => member.userId}
        >
          {(member) => (
            <ItemRow
              title={member.username}
              actions={
                <Button
                  variant="ghost"
                  size="row"
                  disabled={busy}
                  onClick={() => onDrop(member.userId)}
                >
                  Take out
                </Button>
              }
            />
          )}
        </PagedList>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Add someone"
          value={adding}
          options={[
            { value: "", label: candidates.length === 0 ? "Nobody to add" : "Choose a person" },
            ...candidates.map((user) => ({ value: user.userId, label: user.username })),
          ]}
          onChange={onAdding}
          className="min-w-0 flex-1 basis-48"
        />
        <Button
          size="sm"
          disabled={busy || adding === ""}
          onClick={() => {
            if (adding !== "") onAdd(adding);
          }}
        >
          Add
        </Button>
      </div>
      {users.status === "ready" && users.next.kind === "more" ? (
        <Muted>
          <button type="button" className="cursor-pointer underline" onClick={users.next.load}>
            Load more people to choose from
          </button>
        </Muted>
      ) : null}
    </div>
  );
}
