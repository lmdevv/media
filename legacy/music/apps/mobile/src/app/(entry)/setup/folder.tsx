/**
 * E05 · Add your music (setup 2 of 3): the server folders to read and who may listen. Start
 * scanning adds each folder as a library; the first one moves the root stack on to the scan
 * (E06), which stays on screen until the owner leaves it. Add another folder adds a field, so
 * every folder is checked before any library exists. A refusal keeps the form.
 */
import { useRun } from "@music/sdk/react";
import { Folder } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { accountFailureLine } from "@/lib/account-form";
import { parseFolders } from "@/lib/library-folders";
import { useSetupProgress } from "@/session/session-phase";

/** Who can listen, as Paper offers it: everyone on the server, or only the owner. */
type Listeners = "shared" | "private";

const LISTENERS = [
  { value: "shared", label: "Everyone" },
  { value: "private", label: "Only me" },
] as const;

/** One folder field; its id stays put as fields are added below it. */
interface FolderField {
  readonly id: number;
  readonly path: string;
}

/** Why a folder field can't be used, and which one. */
interface FolderFailure {
  readonly index: number;
  readonly message: string;
}

export default function AddFolder() {
  const createLibrary = useRun("libraries.create");
  const { setProgress } = useSetupProgress();
  const [paths, setPaths] = useState<ReadonlyArray<FolderField>>([{ id: 0, path: "/music" }]);
  const [listeners, setListeners] = useState<Listeners>("shared");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FolderFailure | null>(null);

  const submit = async () => {
    const parsed = parseFolders(paths.map((field) => field.path));

    if (!parsed.ok) {
      setFailure(parsed);

      return;
    }

    setPending(true);
    setFailure(null);
    setProgress("followingScan");

    const [first, ...rest] = parsed.folders;

    if (first === undefined) return;

    try {
      await createLibrary({ ...first, visibility: listeners });
    } catch (cause) {
      setProgress("none");
      setFailure({ index: 0, message: accountFailureLine(cause) });
      setPending(false);

      return;
    }

    // The first library puts the scan on screen, so a refusal of a later one can't be shown here;
    // the scan screen lists only the folders that were added.
    await Promise.allSettled(
      rest.map((folder) => createLibrary({ ...folder, visibility: listeners })),
    );
  };

  return (
    <Page
      title="Add your music"
      bottom="plain"
      onBack={null}
      trailing={
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Folder} />
        </View>
      }
    >
      <Text variant="mono" tone="muted">
        SETUP · 2 OF 3
      </Text>
      <Text variant="hero" accessibilityRole="header" className="pt-6">
        {"Where’s your\ncollection?"}
      </Text>
      {paths.map(({ id, path }, index) => (
        <Field
          key={id}
          label={index === 0 ? "Library folder" : "Another folder"}
          {...(index === 0
            ? { helper: "An absolute path on the server or inside its container." }
            : {})}
          value={path}
          onChangeText={(text) => {
            setPaths((list) => list.map((field) => (field.id === id ? { id, path: text } : field)));
            setFailure(null);
          }}
          placeholder="/music"
          autoCapitalize="none"
          keyboardType="url"
          editable={!pending}
          error={failure?.index === index ? failure.message : null}
          autoFocus={index > 0}
        />
      ))}
      <SectionHeader title="Who can listen" />
      <ChipGroup
        label="Who can listen"
        options={LISTENERS}
        value={listeners}
        onChange={setListeners}
      />
      <Notice
        icon={Folder}
        title="Your files stay yours"
        body="[music] reads your tags and artwork. It doesn’t move or rewrite your music."
      />
      <View className="pt-6">
        <Button
          label="Start scanning"
          pendingLabel="Starting…"
          pending={pending}
          disabled={paths[0]?.path.trim() === ""}
          onPress={() => void submit()}
        />
      </View>
      <View className="pt-3">
        <Button
          label="Add another folder"
          variant="secondary"
          disabled={pending}
          onPress={() => setPaths((list) => [...list, { id: list.length, path: "" }])}
        />
      </View>
    </Page>
  );
}
