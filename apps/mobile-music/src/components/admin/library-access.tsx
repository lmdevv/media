import { ROLE_LABELS } from "@media/mobile-core/accounts";
import { Folder, Info, Plus, Users, X } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { LibraryView } from "@/lib/first-scan";
import type { LibraryId, UserId } from "@/lib/ids";
import type { Me } from "@/lib/models";
import { personName } from "@/lib/people";
import { useCore } from "@/lib/platform";

import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";

import { sharedWithEveryone, useLibrary, useLibraryGrants, usePeople } from "./data";

/** Who can listen to a library, for someone who manages it. */
export function LibraryAccessPage({ me, id }: { readonly me: Me; readonly id: LibraryId | null }) {
  const library = useLibrary(id);

  if (library === undefined) {
    return (
      <Page title="Library access" bottom="plain">
        {null}
      </Page>
    );
  }

  if (library === null || library.level !== "manage") {
    return (
      <Page title="Library access" bottom="plain">
        <EmptyState
          icon={Folder}
          title={"Not a library\nyou manage."}
          body={"It was removed, or only its\nowner can change it."}
        />
      </Page>
    );
  }

  return <AccessList me={me} library={library} />;
}

const LEVEL_LINES = {
  view: "Can listen",
  edit: "Can listen and edit",
  manage: "Manages it",
} as const;

/**
 * The people a library is shared with by name, each removable but the ones who manage it, and
 * everyone else in the household to add. A person added can listen (`view`), as old music's
 * library access let them; the core keeps a library private to its maker until shared (ADR 0024).
 */
function AccessList({ me, library }: { readonly me: Me; readonly library: LibraryView }) {
  const core = useCore();
  const grants = useLibraryGrants(library.libraryId);
  const people = usePeople();
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const resource = { type: "library", id: library.libraryId } as const;

  const named = (grants ?? []).flatMap((grant) =>
    grant.principal.kind === "user"
      ? [{ userId: grant.principal.userId, username: grant.principal.username, level: grant.level }]
      : [],
  );

  const added = new Set<string>(named.map((person) => person.userId));

  const candidates = (people ?? []).filter(
    (person) => person.userId !== me.userId && !added.has(person.userId),
  );

  const toggleAdding = () => setAdding((open) => !open);

  const give = (userId: UserId) =>
    action.run(async () => {
      await core.permissions.grants.set({
        resource,
        principal: { kind: "user", userId },
        level: "view",
      });
    });

  const take = (userId: UserId) =>
    action.run(async () => {
      await core.permissions.grants.remove({ resource, principal: { kind: "user", userId } });
    });

  const everyone = grants !== undefined && sharedWithEveryone(grants);

  return (
    <Page
      title="Library access"
      bottom="plain"
      trailing={<IconButton icon={Plus} label="Add a person" onPress={toggleAdding} />}
    >
      <Notice
        icon={Folder}
        title={library.name}
        body={
          everyone
            ? "Shared · Everyone on the server can listen, and the people below."
            : "Private · You and the people below can listen."
        }
      />
      {named.map((person) => (
        <Row
          key={person.userId}
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          title={person.username}
          subtitle={`${LEVEL_LINES[person.level]}${person.userId === me.userId ? " · You" : ""}`}
          trailingAction={
            person.level === "manage" ? null : (
              <IconButton
                icon={X}
                label={`Remove ${person.username}`}
                tone="muted"
                size="inline"
                disabled={action.pending}
                onPress={() => take(person.userId)}
              />
            )
          }
        />
      ))}
      <View className="pt-6">
        {adding ? (
          <Button label="Done adding" variant="secondary" onPress={toggleAdding} />
        ) : (
          <Button label="Add a person" icon={Plus} onPress={toggleAdding} />
        )}
      </View>
      {adding ? (
        <>
          <SectionHeader title="Add someone" />
          {candidates.length === 0 ? (
            <Text variant="secondary" tone="muted" className="pb-2">
              {people === undefined || grants === undefined
                ? ""
                : "Everyone who can be added can already listen."}
            </Text>
          ) : (
            candidates.map((person) => (
              <Row
                key={person.userId}
                leading={{ kind: "icon", icon: Plus, tone: "muted" }}
                title={personName(person)}
                subtitle={ROLE_LABELS[person.role]}
                accessibilityLabel={`Add ${personName(person)}, ${ROLE_LABELS[person.role]}`}
                onPress={() => give(person.userId)}
              />
            ))
          )}
        </>
      ) : null}
      <View className="pt-5">
        <Notice
          icon={Info}
          title="Private until shared"
          body="A library reaches only its maker until it is shared, admins included."
        />
      </View>
      <Failure message={action.failure} />
    </Page>
  );
}
