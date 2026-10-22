/**
 * F15 · Library: rename it, see its folder, choose who can listen, open its access list, save,
 * scan it again, or remove it. The name and visibility are drafts until Save changes sends only
 * what changed; untouched, they follow the saved library live.
 */
import type { LibraryId } from "@music/commands/ids";
import type { Library, LibraryVisibility, User } from "@music/commands/models";
import { canRemoveLibrary } from "@music/commands/permissions";
import { useRead, useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Folder, Lock, RotateCw, Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { accessNote, libraryOwner, visibilityCallout, visibilityChoices } from "@/lib/libraries";
import { joinNames, personName } from "@/lib/people";

import { useLibrary } from "./data";
import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";
import { useFlash } from "@/components/settings/use-flash";

/** A library's settings page, for someone who may manage it. */
export function LibraryPage({ me, id }: { readonly me: User; readonly id: LibraryId | null }) {
  const library = useLibrary(id);

  if (library === undefined) {
    return (
      <Page title="" bottom="plain">
        {null}
      </Page>
    );
  }

  if (library === null || !library.manageable) {
    return (
      <Page title="Library" bottom="plain">
        <EmptyState
          icon={Folder}
          title={"Not a library\nyou manage."}
          body={"It was removed, or only its\nowner can change it."}
        />
      </Page>
    );
  }

  return <LibraryEditor me={me} library={library} />;
}

/** Who can listen besides the owner, in the `People with access` row. */
const accessLine = (
  library: Library,
  owner: string,
  names: ReadonlyArray<string> | undefined,
): string => {
  if (names === undefined) return "";

  if (library.visibility === "shared") {
    return names.length === 0 ? "Server members" : `Server members and ${joinNames(names)}`;
  }

  return names.length === 0 ? `Only ${owner}` : joinNames(names);
};

/** The changes Save changes sends: only what differs from the saved library. */
interface LibraryChanges {
  libraryId: LibraryId;
  name?: string;
  visibility?: LibraryVisibility;
}

function LibraryEditor({ me, library }: { readonly me: User; readonly library: Library }) {
  const update = useRun("libraries.update");
  const scan = useRun("libraries.scan");
  const save = useAction();
  const rescan = useAction();
  const [saved, flashSaved] = useFlash();
  const [name, setName] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<LibraryVisibility | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The access list is only for a library's managers, and a private library has none.
  const members = useRead(
    "libraries.people",
    library.visibility === "private" ? "skip" : { libraryId: library.id },
  );

  const owner = libraryOwner(library, me.id);
  const shownName = name ?? library.name;
  const shownVisibility = visibility ?? library.visibility;
  const trimmed = shownName.trim();
  const choices = visibilityChoices(library.accessControl, library.visibility);
  const callout = visibilityCallout(shownVisibility, owner);
  const note = accessNote(library.accessControl, owner);
  const changes: LibraryChanges = { libraryId: library.id };

  if (trimmed !== library.name) changes.name = trimmed;

  if (shownVisibility !== library.visibility) changes.visibility = shownVisibility;

  const changed = changes.name !== undefined || changes.visibility !== undefined;

  const submit = () => {
    if (trimmed.length === 0) {
      setProblem("Give the library a name.");

      return;
    }

    setProblem(null);

    save.run(async () => {
      await update(changes);
      setName(null);
      setVisibility(null);
      flashSaved();
    });
  };

  const scanNow = () =>
    rescan.run(async () => {
      const { jobId } = await scan({ libraryId: library.id });

      router.push({ pathname: "/settings/admin/jobs/[id]", params: { id: jobId } });
    });

  return (
    <Page title={library.name} bottom="plain">
      <Field
        label="Library name"
        value={shownName}
        onChangeText={setName}
        returnKeyType="done"
        error={problem}
      />
      <Row
        leading={{ kind: "icon", icon: Folder, tone: "muted" }}
        title={library.path ?? library.name}
        subtitle="Folder on the server · Read-only"
      />
      <SectionHeader title="Who can listen" />
      {choices.length > 1 ? (
        <ChipGroup
          label="Who can listen"
          options={choices}
          value={shownVisibility}
          onChange={setVisibility}
        />
      ) : (
        <View className="pb-3" />
      )}
      <Notice
        icon={shownVisibility === "shared" ? Folder : Lock}
        title={callout.title}
        body={callout.body}
      />
      {note === null ? null : (
        <Text variant="secondary" tone="muted" className="pt-2">
          {note}
        </Text>
      )}
      {library.visibility === "private" ? null : (
        <Row
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          title="People with access"
          subtitle={accessLine(library, owner, members?.map(personName))}
          trailing={<RowChevron />}
          onPress={() =>
            router.push({
              pathname: "/settings/admin/libraries/[id]/access",
              params: { id: library.id },
            })
          }
        />
      )}
      <View className="flex-row gap-3 pt-6">
        <Button
          label={saved && !changed ? "Saved" : "Save changes"}
          pendingLabel="Saving…"
          pending={save.pending}
          disabled={!changed && !saved}
          onPress={changed ? submit : undefined}
          className="flex-1"
        />
        <Button
          label="Scan now"
          pendingLabel="Starting…"
          variant="secondary"
          icon={RotateCw}
          pending={rescan.pending}
          onPress={scanNow}
          className="flex-1"
        />
      </View>
      {canRemoveLibrary(me, library) ? (
        <View className="pt-3">
          <Button
            label="Remove library"
            variant="destructive"
            onPress={() =>
              router.push({
                pathname: "/settings/admin/libraries/[id]/remove",
                params: { id: library.id },
              })
            }
          />
        </View>
      ) : null}
      <Failure message={save.failure ?? rescan.failure} />
    </Page>
  );
}
