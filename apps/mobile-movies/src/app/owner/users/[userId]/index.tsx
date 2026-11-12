import {
  ACCESS_LABELS,
  ROLE_CHOICES,
  ROLE_LABELS,
  accessChangeable,
  canChangeRole,
  libraryAccess,
} from "@media/mobile-core/accounts";
import type { AssignableRole, HouseholdUser, LibraryAccess } from "@media/mobile-core/accounts";
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

/** One library on the page, with what the person reaches in it as saved. */
interface LibraryRow {
  readonly library: Library;
  readonly saved: LibraryAccess | null;
}

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
  const changeable = canChangeRole(user, me.userId);
  const [role, setRoleChoice] = useState<HouseholdUser["role"]>(user.role);
  const [toggled, setToggled] = useState<ReadonlySet<LibraryId>>(new Set());

  const rows = libraries.map((library, at): LibraryRow => {
    const list = grants[at];

    return {
      library,
      saved:
        list?.status === "ready" && list.next.kind === "done"
          ? libraryAccess(user.userId, role, list.rows)
          : null,
    };
  });

  const shown = (row: LibraryRow): LibraryAccess | null => {
    if (row.saved === null || !toggled.has(row.library.libraryId)) return row.saved;

    return row.saved === "allowed" ? "notAllowed" : "allowed";
  };

  const roleChanged = role !== user.role;
  const changes = rows.filter((row) => toggled.has(row.library.libraryId) && row.saved !== null);

  const chosenRole = (): AssignableRole | null =>
    roleChanged ? (ROLE_CHOICES.find((choice) => choice === role) ?? null) : null;

  const saving = useTask(async () => {
    await save({
      userId: user.userId,
      role: chosenRole(),
      give:
        role === "member"
          ? changes.filter((row) => row.saved === "notAllowed").map((row) => row.library.libraryId)
          : [],
      takeAway:
        role === "member"
          ? changes.filter((row) => row.saved === "allowed").map((row) => row.library.libraryId)
          : [],
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

  const toggle = (libraryId: LibraryId) =>
    setToggled((current) => {
      const next = new Set(current);

      if (!next.delete(libraryId)) next.add(libraryId);

      return next;
    });

  return (
    <OwnerScreen title={user.username} fallback="/owner/users">
      <ListRow
        icon={UserIcon}
        title="Role"
        detail={ROLE_LABELS[role]}
        onPress={changeable ? chooseRole : undefined}
      />
      {libraries.length === 0 ? null : <SectionHeading>Library Access</SectionHeading>}
      {rows.map((row) => {
        const access = shown(row);

        return (
          <ListRow
            key={row.library.libraryId}
            icon={Folder}
            title={row.library.name}
            detail={access === null ? undefined : ACCESS_LABELS[access]}
            chevron={false}
            onPress={
              changeable && access !== null && accessChangeable(access)
                ? () => toggle(row.library.libraryId)
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
      {changeable ? (
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
