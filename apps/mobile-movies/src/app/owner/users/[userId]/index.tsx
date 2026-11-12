import {
  ACCESS_LABELS,
  ROLE_CHOICES,
  ROLE_LABELS,
  accessChangeable,
  canChangeRole,
  libraryAccess,
} from "@media/mobile-core/accounts";
import type {
  AssignableRole,
  HouseholdUser,
  LibraryAccess,
  LibraryGrant,
  UserId,
} from "@media/mobile-core/accounts";
import type { Paged } from "@media/mobile-core/pages";
import { useHousehold, useLibraryGrants, useSavePerson } from "@media/mobile-core/use-accounts";
import { router, useLocalSearchParams } from "expo-router";
import { Folder, User as UserIcon } from "lucide-react-native";
import { useState } from "react";

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
import type { Library, LibraryId } from "@/lib/owner";
import { useMe } from "@/session/me";

/** What a person reaches in a library as the core holds it, or why the page cannot say yet. */
type Saved =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "known"; readonly access: LibraryAccess };

/** A choice the admin made on the page: the person's own grant given or taken away. */
type Chosen = "allowed" | "notAllowed";

/** One library on the page, with what the person reaches in it as saved. */
interface LibraryRow {
  readonly library: Library;
  readonly saved: Saved;
}

const savedOf = (list: Paged<LibraryGrant> | undefined, userId: UserId): Saved => {
  if (list?.status === "failed") return { kind: "failed", retry: list.retry };

  if (list?.status === "ready" && list.next.kind === "failed") {
    return { kind: "failed", retry: list.next.retry };
  }

  return list?.status === "ready" && list.next.kind === "done"
    ? { kind: "known", access: libraryAccess(userId, list.rows) }
    : { kind: "loading" };
};

/**
 * What a row shows: the admin's choice while the saved access is one they can change, else the
 * saved access. A choice that the core now holds, or that a household or manager grant overtook,
 * is no longer a change.
 */
const shownOf = (row: LibraryRow, chosen: Chosen | undefined): LibraryAccess | null => {
  if (row.saved.kind !== "known") return null;

  return chosen !== undefined && accessChangeable(row.saved.access) ? chosen : row.saved.access;
};

const isChange = (row: LibraryRow, chosen: Chosen | undefined): boolean =>
  row.saved.kind === "known" &&
  accessChangeable(row.saved.access) &&
  chosen !== undefined &&
  chosen !== row.saved.access;

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
  const roleChangeable = canChangeRole(user, me.userId);
  // Access follows grants for every role, so an admin may share a library with anyone but
  // themselves, the owner included.
  const accessChangeableHere = user.userId !== me.userId;
  const [role, setRoleChoice] = useState<HouseholdUser["role"]>(user.role);
  const [chosen, setChosen] = useState<ReadonlyMap<LibraryId, Chosen>>(new Map());

  const rows = libraries.map((library, at): LibraryRow => ({
    library,
    saved: savedOf(grants[at], user.userId),
  }));

  const roleChanged = role !== user.role;
  const changes = rows.filter((row) => isChange(row, chosen.get(row.library.libraryId)));

  const chosenRole = (): AssignableRole | null =>
    roleChanged ? (ROLE_CHOICES.find((choice) => choice === role) ?? null) : null;

  const saving = useTask(async () => {
    const want = (access: Chosen) =>
      changes
        .filter((row) => chosen.get(row.library.libraryId) === access)
        .map((row) => row.library.libraryId);

    await save({
      userId: user.userId,
      role: chosenRole(),
      give: want("allowed"),
      takeAway: want("notAllowed"),
    });
    router.back();
  });

  const chooseRole = () =>
    showActions(
      "Role",
      ROLE_CHOICES.map((choice) => ({
        label: ROLE_LABELS[choice],
        onPress: () => setRoleChoice(choice),
      })),
    );

  const choose = (libraryId: LibraryId, access: Chosen) =>
    setChosen((current) => new Map([...current, [libraryId, access]]));

  return (
    <OwnerScreen title={user.username} fallback="/owner/users">
      <ListRow
        icon={UserIcon}
        title="Role"
        detail={ROLE_LABELS[role]}
        onPress={roleChangeable ? chooseRole : undefined}
      />
      {libraries.length === 0 ? null : <SectionHeading>Library Access</SectionHeading>}
      {rows.map((row) => {
        const { libraryId } = row.library;
        const access = shownOf(row, chosen.get(libraryId));

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

        return (
          <ListRow
            key={libraryId}
            icon={Folder}
            title={row.library.name}
            detail={access === null ? undefined : ACCESS_LABELS[access]}
            chevron={false}
            onPress={
              accessChangeableHere && access !== null && accessChangeable(access)
                ? () => choose(libraryId, access === "allowed" ? "notAllowed" : "allowed")
                : undefined
            }
          />
        );
      })}
      {saving.error === null ? null : (
        <Text variant="meta" tone="danger">
          {saving.error}
        </Text>
      )}
      {roleChangeable || accessChangeableHere ? (
        <>
          <Spacer />
          <Button
            label="Save Changes"
            busy={saving.busy}
            disabled={!roleChanged && changes.length === 0}
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
