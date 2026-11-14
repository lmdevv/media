import { router } from "expo-router";
import { Folder, Plus, RotateCw } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import { libraryAdminLine } from "@/lib/libraries";

import { useManagedLibraries } from "./data";

const addLibrary = () => router.push("/settings/admin/libraries/new");

/** The music libraries you manage, each opening its settings. */
export function LibrariesList() {
  const libraries = useManagedLibraries();

  return (
    <Page
      title="Libraries"
      bottom="plain"
      trailing={<IconButton icon={Plus} label="Add library folder" onPress={addLibrary} />}
    >
      {libraries === undefined ? null : libraries.length === 0 ? (
        <EmptyState
          icon={Folder}
          title={"Your collection\nstarts here."}
          body={"Add a folder on your server.\nWe’ll take it from there."}
          primary={<Button label="Add library folder" onPress={addLibrary} />}
        />
      ) : (
        <>
          <Text tone="muted" className="pb-5">
            Folders on your server. Your files stay in place.
          </Text>
          {libraries.map((library) => (
            <Row
              key={library.libraryId}
              leading={{ kind: "icon", icon: Folder, tone: "muted" }}
              title={library.name}
              subtitle={libraryAdminLine(library)}
              trailing={<RowChevron />}
              onPress={() =>
                router.push({
                  pathname: "/settings/admin/libraries/[id]",
                  params: { id: library.libraryId },
                })
              }
            />
          ))}
          <Notice
            icon={RotateCw}
            title="Live updates"
            body="Folders are watched for changes. Run a scan to read them again."
          />
          <View className="pt-6">
            <Button label="Add library folder" icon={Plus} onPress={addLibrary} />
          </View>
        </>
      )}
    </Page>
  );
}
