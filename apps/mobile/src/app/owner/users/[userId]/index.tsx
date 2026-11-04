import type { LibraryId } from "@media/contracts/ids";
import { UserId } from "@media/contracts/ids";
import type { User } from "@media/contracts/models/account";
import type { LibraryDetail } from "@media/contracts/models/catalog";
import type { AssignableRole } from "@media/contracts/scopes";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Ellipsis, Folder, User as UserIcon } from "lucide-react-native";
import { useState } from "react";

import {
  Loading,
  LoadFailure,
  OwnerScreen,
  SectionHeading,
  Spacer,
  showActions,
} from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { useOwnerViewer } from "@/components/owner/viewer";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { ROLE_LABELS, accessRows, canChange, grantsOf, sameGrants } from "@/lib/household";

const decodeUserId = Schema.decodeUnknownSync(UserId);

const ROLE_CHOICES: ReadonlyArray<AssignableRole> = ["member", "admin"];

function Person({
  user,
  libraries,
}: {
  readonly user: User;
  readonly libraries: ReadonlyArray<LibraryDetail>;
}) {
  const viewer = useOwnerViewer();
  const setRole = useCommand("users.setRole");
  const setAccess = useCommand("users.setLibraryAccess");
  const enable = useCommand("users.enable");
  const changeable = canChange(user, viewer.user.id);
  const saved = grantsOf(user.id, libraries);
  const [role, setRoleChoice] = useState<User["role"]>(user.role);
  const [granted, setGranted] = useState<ReadonlyArray<LibraryId>>(saved);
  const roleChanged = role !== user.role;
  const accessChanged = !sameGrants(granted, saved);

  const save = useTask(async () => {
    if (roleChanged && (role === "admin" || role === "member")) {
      await setRole({ userId: user.id, role });
    }

    if (accessChanged && role === "member") {
      await setAccess({ userId: user.id, libraryIds: granted });
    }

    router.back();
  });

  const reenable = useTask(() => enable({ userId: user.id }));

  const chooseRole = () =>
    showActions(
      "Role",
      ROLE_CHOICES.map((choice) => ({
        label: ROLE_LABELS[choice],
        onPress: () => setRoleChoice(choice),
      })),
    );

  const disable = () =>
    router.push({
      pathname: "/owner/users/[userId]/disable",
      params: { userId: user.id, name: user.name },
    });

  const error = save.error ?? reenable.error;

  return (
    <OwnerScreen
      title={user.name}
      fallback="/owner/users"
      trailing={
        changeable ? (
          <IconButton
            icon={Ellipsis}
            label={`More for ${user.name}`}
            onPress={() =>
              showActions(user.name, [
                user.disabled
                  ? { label: "Enable Account", onPress: () => void reenable.run() }
                  : { label: "Disable Account", destructive: true, onPress: disable },
              ])
            }
          />
        ) : undefined
      }
    >
      <ListRow
        icon={UserIcon}
        title="Role"
        detail={user.disabled ? `${ROLE_LABELS[role]} · Disabled` : ROLE_LABELS[role]}
        onPress={changeable ? chooseRole : undefined}
      />
      {libraries.length === 0 ? null : <SectionHeading>Library Access</SectionHeading>}
      {accessRows(role, libraries, granted).map((row) => (
        <ListRow
          key={row.libraryId}
          icon={Folder}
          title={row.name}
          detail={row.detail}
          chevron={false}
          onPress={
            changeable && row.changeable
              ? () =>
                  setGranted((current) =>
                    row.allowed
                      ? current.filter((id) => id !== row.libraryId)
                      : [...current, row.libraryId],
                  )
              : undefined
          }
        />
      ))}
      {error === null ? null : (
        <Text variant="meta" tone="danger">
          {error}
        </Text>
      )}
      {changeable ? (
        <>
          <Spacer />
          <Button
            label="Save Changes"
            busy={save.busy}
            disabled={!roleChanged && !accessChanged}
            onPress={() => void save.run()}
          />
          {user.disabled ? (
            <Button
              label="Enable Account"
              variant="secondary"
              busy={reenable.busy}
              onPress={() => void reenable.run()}
            />
          ) : (
            <Button label="Disable Account" variant="destructive" onPress={disable} />
          )}
        </>
      ) : null}
    </OwnerScreen>
  );
}

export default function PersonScreen() {
  const params = useLocalSearchParams<{ userId: string }>();
  const userId = decodeUserId(params.userId);
  const users = useCommandQuery("users.list", {});
  const libraries = useCommandQuery("libraries.listDetails", {});

  if (users.status === "error") {
    return (
      <OwnerScreen title="Person" fallback="/owner/users">
        <LoadFailure error={users.error} retry={users.retry} />
      </OwnerScreen>
    );
  }

  if (libraries.status === "error") {
    return (
      <OwnerScreen title="Person" fallback="/owner/users">
        <LoadFailure error={libraries.error} retry={libraries.retry} />
      </OwnerScreen>
    );
  }

  if (users.status === "loading" || libraries.status === "loading") {
    return (
      <OwnerScreen title="" fallback="/owner/users">
        <Loading />
      </OwnerScreen>
    );
  }

  const user = users.data.find((candidate) => candidate.id === userId);

  if (user === undefined) {
    return (
      <OwnerScreen title="Person" fallback="/owner/users">
        <Text tone="muted">This account is gone.</Text>
      </OwnerScreen>
    );
  }

  return <Person key={user.id} user={user} libraries={libraries.data} />;
}
