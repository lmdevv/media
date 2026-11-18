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
import { REACHES, folderProblem, nameFromFolder } from "@/lib/libraries";
import type { LibraryReach } from "@/lib/libraries";
import { useCore } from "@/lib/platform";

import { NavGlyph } from "@/components/settings/nav-glyph";
import { useAction } from "@/components/settings/use-action";

/** The add-a-library form: a music library that reads one folder, and scans it. */
export function NewLibraryForm() {
  const core = useCore();
  const action = useAction();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [reach, setReach] = useState<LibraryReach>("shared");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    const path = folder.trim();
    const refusal = folderProblem(path);
    setProblem(refusal);

    if (refusal !== null) return;
    const typed = name.trim();
    const title = typed.length === 0 ? nameFromFolder(path) : typed;

    action.run(async () => {
      const { libraryId, scanJobId } = await core.libraries.create({
        name: title,
        kind: "music",
        folders: [path],
      });

      if (reach === "shared") {
        await core.permissions.grants.set({
          resource: { type: "library", id: libraryId },
          principal: { kind: "household" },
          level: "view",
        });
      }

      router.replace({ pathname: "/settings/admin/jobs/[id]", params: { id: scanJobId } });
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
      <ChipGroup label="Who can listen" options={REACHES} value={reach} onChange={setReach} />
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
