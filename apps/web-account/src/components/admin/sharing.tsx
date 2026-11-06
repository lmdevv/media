import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Match } from "effect";
import { useState } from "react";

import { useActions } from "./action";
import { LEVEL_LABELS } from "./libraries";
import { useAllPages, usePages } from "./pages";
import type { Paged } from "./pages";
import { ItemRow, PagedList, Section, SelectField } from "./parts";
import type { Choice } from "./parts";
import type { Grant, Group, Level, LibraryId, Principal, User } from "./types";

/** Who a grant names, as a select's value: `household`, `user:<id>`, or `group:<id>`. */
type PrincipalKey = "" | "household" | `user:${string}` | `group:${string}`;

const keyOf = (principal: Grant["principal"]): PrincipalKey =>
  Match.value(principal).pipe(
    Match.discriminatorsExhaustive("kind")({
      household: (): PrincipalKey => "household",
      user: ({ userId }): PrincipalKey => `user:${userId}`,
      group: ({ groupId }): PrincipalKey => `group:${groupId}`,
    }),
  );

/** A grant's principal in the shape `grants.set` and `grants.remove` take. */
const principalOf = (principal: Grant["principal"]): Principal =>
  Match.value(principal).pipe(
    Match.discriminatorsExhaustive("kind")({
      household: (): Principal => ({ kind: "household" }),
      user: ({ userId }): Principal => ({ kind: "user", userId }),
      group: ({ groupId }): Principal => ({ kind: "group", groupId }),
    }),
  );

/** Who a grant reaches, as a person reads it. */
const principalLabel = (principal: Grant["principal"]): string =>
  Match.value(principal).pipe(
    Match.discriminatorsExhaustive("kind")({
      household: () => "Everyone on this server",
      user: ({ username }) => username,
      group: ({ name }) => `${name} (group)`,
    }),
  );

/** Only a person can manage; a group or the household gets view or edit. */
const levelChoices = (kind: Grant["principal"]["kind"]): ReadonlyArray<Choice<Level>> =>
  kind === "user"
    ? [
        { value: "view", label: LEVEL_LABELS.view },
        { value: "edit", label: LEVEL_LABELS.edit },
        { value: "manage", label: LEVEL_LABELS.manage },
      ]
    : [
        { value: "view", label: LEVEL_LABELS.view },
        { value: "edit", label: LEVEL_LABELS.edit },
      ];

/** Who a library is shared with, for a manager of it. */
export function Sharing({ libraryId }: { readonly libraryId: LibraryId }) {
  const platform = usePlatform();
  const grantsApi = platform.core.permissions.grants;
  const resource = { type: "library", id: libraryId } as const;
  const grants = usePages(grantsApi.list, (paginationOpts) => ({ resource, paginationOpts }));

  const users = useAllPages(platform.core.accounts.users.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const groups = useAllPages(platform.core.permissions.groups.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const actions = useActions<string>();

  const [adding, setAdding] = useState<{ readonly who: PrincipalKey; readonly level: Level }>({
    who: "",
    level: "view",
  });

  const people = users.status === "ready" ? users.rows : [];
  const teams = groups.status === "ready" ? groups.rows : [];

  const toPrincipal = (who: PrincipalKey): Principal | null => {
    if (who === "household") return { kind: "household" };

    const user = people.find((each) => `user:${each.userId}` === who);

    if (user !== undefined) return { kind: "user", userId: user.userId };

    const group = teams.find((each) => `group:${each.groupId}` === who);

    return group === undefined ? null : { kind: "group", groupId: group.groupId };
  };

  const share = async (): Promise<void> => {
    const principal = toPrincipal(adding.who);

    if (principal === null) return;

    const done = await actions.run(
      "add",
      () => grantsApi.set({ resource, principal, level: adding.level }),
      "Shared",
    );

    if (done !== undefined) setAdding({ who: "", level: "view" });
  };

  return (
    <SharingView
      grants={grants}
      users={people}
      groups={teams}
      adding={adding}
      running={actions.running}
      onAdding={setAdding}
      onShare={() => void share()}
      onLevel={(grant, level) =>
        void actions.run(keyOf(grant.principal), () =>
          grantsApi.set({ resource, principal: principalOf(grant.principal), level }),
        )
      }
      onRemove={(grant) =>
        void actions.run(
          keyOf(grant.principal),
          () => grantsApi.remove({ resource, principal: principalOf(grant.principal) }),
          "No longer shared",
        )
      }
    />
  );
}

/** The grants of a library and a form to share it with someone more. */
export function SharingView({
  grants,
  users,
  groups,
  adding,
  running,
  onAdding,
  onShare,
  onLevel,
  onRemove,
}: {
  readonly grants: Paged<Grant>;
  readonly users: ReadonlyArray<User>;
  readonly groups: ReadonlyArray<Group>;
  readonly adding: { readonly who: PrincipalKey; readonly level: Level };
  readonly running: string | null;
  readonly onAdding: (adding: { readonly who: PrincipalKey; readonly level: Level }) => void;
  readonly onShare: () => void;
  readonly onLevel: (grant: Grant, level: Level) => void;
  readonly onRemove: (grant: Grant) => void;
}) {
  const busy = running !== null;

  const shared = new Set(
    grants.status === "ready" ? grants.rows.map((grant) => keyOf(grant.principal)) : [],
  );

  const whoChoices: ReadonlyArray<Choice<PrincipalKey>> = [
    { value: "", label: "Choose who" },
    ...(shared.has("household")
      ? []
      : [{ value: "household" as const, label: "Everyone on this server" }]),
    ...groups.flatMap((group): Array<Choice<PrincipalKey>> =>
      shared.has(`group:${group.groupId}`)
        ? []
        : [{ value: `group:${group.groupId}`, label: `${group.name} (group)` }],
    ),
    ...users.flatMap((user): Array<Choice<PrincipalKey>> =>
      user.role === "guest" || shared.has(`user:${user.userId}`)
        ? []
        : [{ value: `user:${user.userId}`, label: user.username }],
    ),
  ];

  const addingKind = adding.who.startsWith("user:") ? "user" : "group";

  return (
    <Section title="Shared with">
      <PagedList
        label="Shared with"
        list={grants}
        empty="Nobody else."
        rowKey={(grant) => keyOf(grant.principal)}
      >
        {(grant) => (
          <ItemRow
            title={principalLabel(grant.principal)}
            actions={
              <>
                <SelectField
                  label={`Level for ${principalLabel(grant.principal)}`}
                  value={grant.level}
                  options={levelChoices(grant.principal.kind)}
                  disabled={busy}
                  onChange={(level) => onLevel(grant, level)}
                  className="w-36 [&>label]:sr-only"
                />
                <Button variant="ghost" size="row" disabled={busy} onClick={() => onRemove(grant)}>
                  Remove
                </Button>
              </>
            }
          />
        )}
      </PagedList>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Share with"
          value={adding.who}
          options={whoChoices}
          onChange={(who) =>
            onAdding({
              who,
              level: adding.level === "manage" && !who.startsWith("user:") ? "edit" : adding.level,
            })
          }
          className="min-w-0 flex-1 basis-48"
        />
        <SelectField
          label="Level"
          value={adding.level}
          options={levelChoices(addingKind)}
          onChange={(level) => onAdding({ ...adding, level })}
          className="w-36"
        />
        <Button size="sm" disabled={busy || adding.who === ""} onClick={onShare}>
          Share
        </Button>
      </div>
    </Section>
  );
}
