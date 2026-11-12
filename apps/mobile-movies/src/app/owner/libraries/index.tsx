import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { Folder, Plus } from "lucide-react-native";

import { OwnerScreen, PagedView, Spacer } from "@/components/owner/parts";
import { useManagedLibraries } from "@/components/owner/use-libraries";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import type { Library, LibraryDetail } from "@/lib/owner";
import { countOf } from "@/lib/owner-format";
import { isActive } from "@/lib/scans";

const sizeOf = (library: LibraryDetail): string | undefined => {
  if (isActive(library.scan)) return "Scanning";

  return library.items === null ? undefined : countOf(library.items, "Title", "Titles");
};

const add = () => router.push("/owner/libraries/new");

function LibraryRow({ library }: { readonly library: Library }) {
  const platform = usePlatform();
  const detail = usePlatformQuery(platform.core.libraries.get, { libraryId: library.libraryId });

  return (
    <ListRow
      icon={Folder}
      title={library.name}
      detail={detail.status === "success" ? sizeOf(detail.data) : undefined}
      onPress={() =>
        router.push({
          pathname: "/owner/libraries/[libraryId]",
          params: { libraryId: library.libraryId },
        })
      }
    />
  );
}

export default function Libraries() {
  const libraries = useManagedLibraries();

  return (
    <OwnerScreen
      title="Libraries"
      trailing={<IconButton icon={Plus} label="Add Library" onPress={add} />}
    >
      <PagedView list={libraries}>
        {(rows) => rows.map((library) => <LibraryRow key={library.libraryId} library={library} />)}
      </PagedView>
      <Spacer />
      <Button label="Add Library" icon={Plus} onPress={add} />
    </OwnerScreen>
  );
}
