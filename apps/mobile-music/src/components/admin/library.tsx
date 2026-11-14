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
import type { LibraryView } from "@/lib/first-scan";
import type { LibraryId } from "@/lib/ids";
import { REACHES, reachCallout } from "@/lib/libraries";
import type { LibraryReach } from "@/lib/libraries";
import { joinNames } from "@/lib/people";
import { useCore } from "@/lib/platform";

import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";
import { useFlash } from "@/components/settings/use-flash";

import { sharedWithEveryone, useLibrary, useLibraryGrants } from "./data";
import type { LibraryGrant } from "./data";

/** A library's settings page, for someone who manages it. */
export function LibraryPage({ id }: { readonly id: LibraryId | null }) {
  const library = useLibrary(id);

  if (library === undefined) {
    return (
      <Page title="" bottom="plain">
        {null}
      </Page>
    );
  }

  if (library === null || library.level !== "manage") {
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

  return <LibraryEditor library={library} />;
}

/** The people a library is shared with by name, as its access row reads them. */
const peopleOf = (grants: ReadonlyArray<LibraryGrant>): ReadonlyArray<string> =>
  grants.flatMap((grant) => (grant.principal.kind === "user" ? [grant.principal.username] : []));

const accessLine = (reach: LibraryReach, names: ReadonlyArray<string>): string => {
  if (reach === "shared") {
    return names.length === 0 ? "Everyone on the server" : `Everyone, and ${joinNames(names)}`;
  }

  return names.length === 0 ? "Only you" : joinNames(names);
};

function LibraryEditor({ library }: { readonly library: LibraryView }) {
  const core = useCore();
  const grants = useLibraryGrants(library.libraryId);
  const save = useAction();
  const rescan = useAction();
  const [saved, flashSaved] = useFlash();
  const [name, setName] = useState<string | null>(null);
  const [reach, setReach] = useState<LibraryReach | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const savedReach: LibraryReach | null =
    grants === undefined ? null : sharedWithEveryone(grants) ? "shared" : "private";

  const shownName = name ?? library.name;
  const shownReach = reach ?? savedReach ?? "private";
  const trimmed = shownName.trim();
  const callout = reachCallout(shownReach);
  const renamed = trimmed !== library.name;
  const reached = savedReach !== null && shownReach !== savedReach;
  const changed = renamed || reached;
  const household = { kind: "household" } as const;
  const resource = { type: "library", id: library.libraryId } as const;

  const submit = () => {
    if (trimmed.length === 0) {
      setProblem("Give the library a name.");

      return;
    }

    setProblem(null);

    save.run(async () => {
      if (renamed) await core.libraries.rename({ libraryId: library.libraryId, name: trimmed });

      if (reached) {
        await (shownReach === "shared"
          ? core.permissions.grants.set({ resource, principal: household, level: "view" })
          : core.permissions.grants.remove({ resource, principal: household }));
      }

      setName(null);
      setReach(null);
      flashSaved();
    });
  };

  const scanNow = () =>
    rescan.run(async () => {
      const { jobId } = await core.libraries.scan({ libraryId: library.libraryId });

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
      {(library.folders ?? []).map((folder) => (
        <Row
          key={folder}
          leading={{ kind: "icon", icon: Folder, tone: "muted" }}
          title={folder}
          subtitle="Folder on the server · Read-only"
        />
      ))}
      <SectionHeader title="Who can listen" />
      <ChipGroup label="Who can listen" options={REACHES} value={shownReach} onChange={setReach} />
      <Notice
        icon={shownReach === "shared" ? Folder : Lock}
        title={callout.title}
        body={callout.body}
      />
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title="People with access"
        subtitle={grants === undefined ? "" : accessLine(shownReach, peopleOf(grants))}
        trailing={<RowChevron />}
        onPress={() =>
          router.push({
            pathname: "/settings/admin/libraries/[id]/access",
            params: { id: library.libraryId },
          })
        }
      />
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
      <View className="pt-3">
        <Button
          label="Remove library"
          variant="destructive"
          onPress={() =>
            router.push({
              pathname: "/settings/admin/libraries/[id]/remove",
              params: { id: library.libraryId },
            })
          }
        />
      </View>
      <Failure message={save.failure ?? rescan.failure} />
    </Page>
  );
}
