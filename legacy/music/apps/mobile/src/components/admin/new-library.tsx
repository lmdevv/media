/**
 * F17 · Add library: a name, a folder the server can read, and who can listen. Adding it starts
 * the first scan, and this page is replaced by that scan's progress (F19). A refusal keeps the
 * form as typed, with the server's reason.
 */
import type { LibraryVisibility } from "@music/commands/models";
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Folder, RotateCw } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { SectionHeader } from "@/components/ui/section-header";
import { VISIBILITIES, folderProblem, nameFromFolder } from "@/lib/libraries";

import { NavGlyph } from "@/components/settings/nav-glyph";
import { useAction } from "@/components/settings/use-action";

/** The add-a-library form. */
export function NewLibraryForm() {
  const create = useRun("libraries.create");
  const action = useAction();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [visibility, setVisibility] = useState<LibraryVisibility>("shared");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    const path = folder.trim();
    const refusal = folderProblem(path);

    setProblem(refusal);

    if (refusal !== null) return;

    const typed = name.trim();
    const title = typed.length === 0 ? nameFromFolder(path) : typed;

    action.run(async () => {
      const { jobId } = await create({ name: title, path, visibility });

      router.replace({ pathname: "/settings/admin/jobs/[id]", params: { id: jobId } });
    });
  };

  return (
    <Page title="Add library" bottom="plain" trailing={<NavGlyph icon={Folder} />}>
      <Field label="Name" value={name} onChangeText={setName} returnKeyType="next" />
      <Field
        label="Server folder"
        helper="Use a folder the server can already read."
        value={folder}
        onChangeText={setFolder}
        autoCapitalize="none"
        keyboardType="url"
        returnKeyType="done"
        error={problem ?? action.failure}
      />
      <SectionHeader title="Who can listen" />
      <ChipGroup
        label="Who can listen"
        options={VISIBILITIES}
        value={visibility}
        onChange={setVisibility}
      />
      <Notice
        icon={RotateCw}
        title="A scan starts automatically"
        body="Your files stay on disk, with their original tags and artwork."
      />
      <View className="pt-6">
        <Button
          label="Add and scan"
          pendingLabel="Adding…"
          pending={action.pending}
          onPress={submit}
        />
      </View>
    </Page>
  );
}
