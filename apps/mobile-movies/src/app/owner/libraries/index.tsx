import type { LibraryDetail } from "@media/contracts/models/catalog";
import { useCommandQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { Folder, Plus } from "lucide-react-native";

import { OwnerScreen, QueryView, Spacer } from "@/components/owner/parts";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { countOf } from "@/lib/owner-format";

const sizeOf = (library: LibraryDetail): string => {
  if (library.scanning) return "Scanning";

  return library.kind === "shows"
    ? countOf(library.titleCount, "Show", "Shows")
    : countOf(library.titleCount, "Title", "Titles");
};

const add = () => router.push("/owner/libraries/new");

export default function Libraries() {
  const libraries = useCommandQuery("libraries.listDetails", {});

  return (
    <OwnerScreen
      title="Libraries"
      trailing={<IconButton icon={Plus} label="Add Library" onPress={add} />}
    >
      <QueryView query={libraries}>
        {(list) =>
          list.map((library) => (
            <ListRow
              key={library.id}
              icon={Folder}
              title={library.name}
              detail={sizeOf(library)}
              onPress={() =>
                router.push({
                  pathname: "/owner/libraries/[libraryId]",
                  params: { libraryId: library.id },
                })
              }
            />
          ))
        }
      </QueryView>
      <Spacer />
      <Button label="Add Library" icon={Plus} onPress={add} />
    </OwnerScreen>
  );
}
