import {
  ROLE_CHOICES,
  ROLE_LABELS,
  accessLabel,
  canChangeRole,
  isChangeable,
  libraryAccess,
  personSave,
  toggledGrant,
} from "@media/mobile-core/accounts";
import type {
  ChangeableGrant,
  GrantedLibrary,
  HouseholdUser,
  LibraryAccess,
  LibraryGrant,
  PageEdit,
  Role,
} from "@media/mobile-core/accounts";
import type { Paged } from "@media/mobile-core/pages";
import {
  useHousehold,
  useLibraryGrants,
  useMemberships,
  useSavePerson,
} from "@media/mobile-core/use-accounts";
import type { Memberships } from "@media/mobile-core/use-accounts";
import { router, useLocalSearchParams } from "expo-router";
import { Folder, User as UserIcon } from "lucide-react-native";
import { useState } from "react";

import { confirmOverwrite } from "@/components/owner/confirm-overwrite";
import {
  OwnerScreen,
  PagedView,
  SectionHeading,
  Spacer,
  showActions,
} from "@/components/owner/parts";
import { useManagedLibraries } from "@/components/owner/use-libraries";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import type { Library } from "@/lib/owner";
import { useMe } from "@/session/me";

/** What a person reaches in a library as the core holds it now, or why the page cannot say yet. */
type Saved =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "known"; readonly access: LibraryAccess };

/** One library on the page, with what the person reaches in it now. */
interface LibraryRow {
  readonly library: Library;
  readonly saved: Saved;
}

const retryOf = <Row,>(list: Paged<Row>): (() => void) | null => {
  if (list.status === "failed") return list.retry;

  return list.status === "ready" && list.next.kind === "failed" ? list.next.retry : null;
};

const savedOf = (
  list: Paged<LibraryGrant> | undefined,
  memberships: Memberships,
  user: HouseholdUser,
): Saved => {
  const retry = list === undefined ? null : retryOf(list);

  if (retry !== null) return { kind: "failed", retry };

  if (memberships.status === "failed") return { kind: "failed", retry: memberships.retry };

  return list?.status === "ready" && list.next.kind === "done" && memberships.status === "ready"
    ? { kind: "known", access: libraryAccess(user.userId, list.rows, memberships.groups) }
    : { kind: "loading" };
};

/** The edit kept for a field: a later change keeps the value the field had at the first one. */
const editFrom = <V,>(earlier: PageEdit<V> | undefined, from: V, to: V): PageEdit<V> => ({
  from: earlier?.from ?? from,
  to,
});

function Person({
  user,
  libraries,
}: {
  readonly user: HouseholdUser;
  readonly libraries: ReadonlyArray<Library>;
}) {
  const me = useMe();
  const save = useSavePerson();
  const grants = useLibraryGrants(libraries.map((library) => library.libraryId));
  const memberships = useMemberships(user.userId);
  const roleChangeable = canChangeRole(user, me.userId);
  // Access follows grants for every role, so an admin may share a library with anyone but
  // themselves, the owner included.
  const grantsChangeable = user.userId !== me.userId;
  // Only what the person changes here, each with the value it had when they changed it: the role
  // and grants on show otherwise follow the core.
  const [roleEdit, setRoleEdit] = useState<PageEdit<Role> | null>(null);

  const [grantEdits, setGrantEdits] = useState<
    ReadonlyMap<GrantedLibrary, PageEdit<ChangeableGrant>>
  >(new Map());

  const rows = libraries.map((library, at): LibraryRow => ({
    library,
    saved: savedOf(grants[at], memberships, user),
  }));

  const plan = personSave(
    roleEdit,
    user.role,
    rows.flatMap((row) => {
      const edit = grantEdits.get(row.library.libraryId);

      return edit === undefined
        ? []
        : [
            {
              libraryId: row.library.libraryId,
              name: row.library.name,
              edit,
              live: row.saved.kind === "known" ? row.saved.access.direct : null,
            },
          ];
    }),
  );

  const changed = plan.role !== null || plan.give.length > 0 || plan.takeAway.length > 0;

  const saving = useTask(async () => {
    if (!(await confirmOverwrite(plan.overtaken))) return;

    await save({ userId: user.userId, role: plan.role, give: plan.give, takeAway: plan.takeAway });
    router.back();
  });

  const shownRole = roleEdit?.to ?? user.role;

  const chooseRole = () =>
    showActions(
      "Role",
      ROLE_CHOICES.map((choice) => ({
        label: ROLE_LABELS[choice],
        onPress: () => setRoleEdit((earlier) => editFrom(earlier ?? undefined, user.role, choice)),
      })),
    );

  const toggle = (libraryId: GrantedLibrary, live: ChangeableGrant, shown: ChangeableGrant) =>
    setGrantEdits((current) => {
      const next = new Map(current);
      const from = current.get(libraryId)?.from ?? live;

      next.set(libraryId, editFrom(current.get(libraryId), live, toggledGrant(shown, from)));

      return next;
    });

  return (
    <OwnerScreen title={user.username} fallback="/owner/users">
      <ListRow
        icon={UserIcon}
        title="Role"
        detail={ROLE_LABELS[shownRole]}
        onPress={roleChangeable ? chooseRole : undefined}
      />
      {libraries.length === 0 ? null : <SectionHeading>Library Access</SectionHeading>}
      {rows.map((row) => {
        const { libraryId } = row.library;

        if (row.saved.kind === "failed") {
          return (
            <ListRow
              key={libraryId}
              icon={Folder}
              title={row.library.name}
              detail="Couldn’t Load · Try Again"
              chevron={false}
              onPress={row.saved.retry}
            />
          );
        }

        if (row.saved.kind === "loading") {
          return <ListRow key={libraryId} icon={Folder} title={row.library.name} chevron={false} />;
        }

        const { direct, inherited } = row.saved.access;

        if (!isChangeable(direct)) {
          return (
            <ListRow
              key={libraryId}
              icon={Folder}
              title={row.library.name}
              detail={accessLabel(direct, inherited)}
              chevron={false}
            />
          );
        }

        const shown = grantEdits.get(libraryId)?.to ?? direct;

        return (
          <ListRow
            key={libraryId}
            icon={Folder}
            title={row.library.name}
            detail={accessLabel(shown, inherited)}
            chevron={false}
            onPress={grantsChangeable ? () => toggle(libraryId, direct, shown) : undefined}
          />
        );
      })}
      {saving.error === null ? null : (
        <Text variant="meta" tone="danger">
          {saving.error}
        </Text>
      )}
      {roleChangeable || grantsChangeable ? (
        <>
          <Spacer />
          <Button
            label="Save Changes"
            busy={saving.busy}
            disabled={!changed}
            onPress={() => void saving.run()}
          />
        </>
      ) : null}
    </OwnerScreen>
  );
}

export default function PersonScreen() {
  const params = useLocalSearchParams<{ userId: string }>();
  const users = useHousehold();
  const libraries = useManagedLibraries();

  const user =
    users.status === "ready" ? users.rows.find((each) => each.userId === params.userId) : undefined;

  if (user !== undefined && libraries.status === "ready" && libraries.next.kind === "done") {
    return <Person key={user.userId} user={user} libraries={libraries.rows} />;
  }

  const gone = user === undefined && users.status === "ready" && users.next.kind === "done";

  return (
    <OwnerScreen title={user?.username ?? "Person"} fallback="/owner/users">
      {gone ? <Text tone="muted">This account is gone.</Text> : null}
      {user === undefined ? (
        <PagedView list={users}>{() => null}</PagedView>
      ) : (
        <PagedView list={libraries}>{() => null}</PagedView>
      )}
    </OwnerScreen>
  );
}
