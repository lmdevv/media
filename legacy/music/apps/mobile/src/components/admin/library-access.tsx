/**
 * F16 · Library access: the owner and the people added to a library. Its owner (`full` control)
 * adds people from an inline list and takes them off; the server's owner standing in (`narrow`)
 * only takes them off. Paper draws a per-person page for revoking; the phone puts Remove on the
 * row instead.
 */
import type { LibraryId, UserId } from "@music/commands/ids";
import type { Library, LibraryVisibility, User } from "@music/commands/models";
import { roleLabel } from "@music/commands/permissions";
import { useRead, useRun } from "@music/sdk/react";
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
import { accessCandidates, libraryOwner } from "@/lib/libraries";
import { personName } from "@/lib/people";

import { useLibrary } from "./data";
import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";

/** Who can listen to a library, for someone who may manage it. */
export function LibraryAccessPage({
  me,
  id,
}: {
  readonly me: User;
  readonly id: LibraryId | null;
}) {
  const library = useLibrary(id);

  if (library === undefined) {
    return (
      <Page title="Library access" bottom="plain">
        {null}
      </Page>
    );
  }

  if (library === null || !library.manageable) {
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

/** What the callout under the nav bar says each visibility lets in. */
const REACH: Readonly<Record<LibraryVisibility, (owner: string) => string>> = {
  shared: () => "Shared · Every member can listen, and the guests below.",
  restricted: () => "Restricted · People below can listen to this library.",
  private: (owner) => `Private · Only ${owner} can listen.`,
};

function AccessList({ me, library }: { readonly me: User; readonly library: Library }) {
  const control = library.accessControl;
  const canAdd = control === "full" && library.visibility !== "private";
  const members = useRead("libraries.people", { libraryId: library.id });
  const people = useRead("people.list", canAdd ? {} : "skip");
  const grant = useRun("libraries.grant");
  const revoke = useRun("libraries.revoke");
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const owner = libraryOwner(library, me.id);
  const yours = library.ownerId === me.id;

  const candidates =
    members === undefined || people === undefined ? [] : accessCandidates(people, members, library);

  const toggleAdding = () => setAdding((open) => !open);

  const give = (userId: UserId) =>
    action.run(async () => {
      await grant({ libraryId: library.id, userId });
    });

  const take = (userId: UserId) =>
    action.run(async () => {
      await revoke({ libraryId: library.id, userId });
    });

  return (
    <Page
      title="Library access"
      bottom="plain"
      trailing={
        canAdd ? <IconButton icon={Plus} label="Add a person" onPress={toggleAdding} /> : undefined
      }
    >
      <Notice icon={Folder} title={library.name} body={REACH[library.visibility](owner)} />
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title={yours ? personName(me) : (library.ownerName ?? "Library owner")}
        subtitle={yours ? "Library owner · You" : "Library owner"}
      />
      {members?.map((member) => {
        const name = personName(member);

        return (
          <Row
            key={member.id}
            leading={{ kind: "icon", icon: Users, tone: "muted" }}
            title={name}
            subtitle="Can listen"
            trailing={
              control === "none" ? null : (
                <IconButton
                  icon={X}
                  label={`Remove ${name}`}
                  tone="muted"
                  size="inline"
                  disabled={action.pending}
                  onPress={() => take(member.id)}
                />
              )
            }
          />
        );
      })}
      {canAdd ? (
        <View className="pt-6">
          {adding ? (
            <Button label="Done adding" variant="secondary" onPress={toggleAdding} />
          ) : (
            <Button label="Add a person" icon={Plus} onPress={toggleAdding} />
          )}
        </View>
      ) : null}
      {canAdd && adding ? (
        <>
          <SectionHeader title="Add someone" />
          {candidates.length === 0 ? (
            <Text variant="secondary" tone="muted" className="pb-2">
              {people === undefined || members === undefined
                ? ""
                : "Everyone who can be added can already listen."}
            </Text>
          ) : (
            candidates.map((person) => (
              <Row
                key={person.id}
                leading={{ kind: "icon", icon: Plus, tone: "muted" }}
                title={personName(person)}
                subtitle={roleLabel(person.role)}
                accessibilityLabel={`Add ${personName(person)}, ${roleLabel(person.role)}`}
                onPress={() => give(person.id)}
              />
            ))
          )}
        </>
      ) : null}
      <View className="pt-5">
        <Notice
          icon={Info}
          title="Guests need explicit access"
          body="Shared libraries are available to server members. Add guests individually when needed."
        />
      </View>
      <Failure message={action.failure} />
    </Page>
  );
}
