/**
 * F14 · Libraries: every folder the caller can see, with its path, who listens, and its size, and
 * the way to add one. With none yet it is G01's empty state.
 */
import type { User } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { Folder, Lock, Plus, RotateCw } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import { libraryAdminLine } from "@/lib/libraries";

const addLibrary = () => router.push("/settings/admin/libraries/new");

/** The server's library folders, each opening its settings when the caller may manage it. */
export function LibrariesList({ me }: { readonly me: User }) {
  const libraries = useRead("libraries.list", {});

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
              key={library.id}
              leading={{
                kind: "icon",
                icon: library.visibility === "shared" ? Folder : Lock,
                tone: "muted",
              }}
              title={library.name}
              subtitle={libraryAdminLine(library, me.id)}
              trailing={library.manageable ? <RowChevron /> : null}
              onPress={
                library.manageable
                  ? () =>
                      router.push({
                        pathname: "/settings/admin/libraries/[id]",
                        params: { id: library.id },
                      })
                  : undefined
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
