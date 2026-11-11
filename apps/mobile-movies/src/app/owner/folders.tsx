import type { ServerFolders } from "@media/contracts/models/catalog";
import { useCommand } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Check, Folder, FolderX, RotateCcw } from "lucide-react-native";
import { useEffect, useState } from "react";

import { InlineState, Loading, OwnerScreen } from "@/components/owner/parts";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { describeFailure, isFailure } from "@/lib/failure";

type Listing =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly listing: ServerFolders }
  | { readonly status: "failed"; readonly cause: unknown };

const useListing = (path: string | undefined) => {
  const folders = useCommand("libraries.folders");
  const [attempt, setAttempt] = useState(0);
  const [listing, setListing] = useState<Listing>({ status: "loading" });

  useEffect(() => {
    let live = true;

    const load = async (): Promise<ServerFolders> => {
      if (path !== undefined) return folders({ path });

      const roots = await folders({});
      const [only, ...others] = roots.folders;

      return only !== undefined && others.length === 0 ? folders({ path: only.path }) : roots;
    };

    const show = async () => {
      setListing({ status: "loading" });

      try {
        const loaded = await load();

        if (live) setListing({ status: "ready", listing: loaded });
      } catch (cause) {
        if (live) setListing({ status: "failed", cause });
      }
    };

    void show();

    return () => {
      live = false;
    };
  }, [folders, path, attempt]);

  return { listing, retry: () => setAttempt((count) => count + 1) };
};

export default function ServerFoldersScreen() {
  const params = useLocalSearchParams<{ returnTo: string; field?: string; path?: string }>();
  const { listing, retry } = useListing(params.path);

  const open = (path: string) =>
    router.push({ pathname: "/owner/folders", params: { ...params, path } });

  const choose = (folder: string) =>
    router.dismissTo({
      pathname: params.returnTo,
      params: { folder, field: params.field ?? "0", picked: String(Date.now()) },
    });

  return (
    <OwnerScreen title="Server Folders">
      {listing.status === "loading" ? <Loading /> : null}
      {listing.status === "failed" ? (
        <>
          <InlineState
            icon={FolderX}
            title="Folder Unavailable"
            description={
              isFailure(listing.cause, "NotFound")
                ? "This folder isn’t available to the server."
                : describeFailure(listing.cause)
            }
          />
          <Button label="Try Again" variant="secondary" icon={RotateCcw} onPress={retry} />
        </>
      ) : null}
      {listing.status === "ready" ? (
        <>
          {listing.listing.path === null ? null : (
            <Text variant="bodyMedium" tone="muted" selectable>
              {listing.listing.path}
            </Text>
          )}
          {listing.listing.folders.length === 0 ? (
            <Text tone="muted">
              {listing.listing.path === null
                ? "The server has no library folders to offer."
                : "No folders inside."}
            </Text>
          ) : (
            listing.listing.folders.map((folder) => (
              <ListRow
                key={folder.path}
                icon={Folder}
                title={folder.name}
                onPress={() => open(folder.path)}
              />
            ))
          )}
          {listing.listing.truncated ? (
            <Text variant="secondary" tone="muted">
              More folders are inside than are shown here. Type the path of one past them.
            </Text>
          ) : null}
          {listing.listing.path === null ? null : (
            <Button
              label="Choose This Folder"
              variant="secondary"
              icon={Check}
              onPress={() => {
                if (listing.listing.path !== null) choose(listing.listing.path);
              }}
            />
          )}
        </>
      ) : null}
    </OwnerScreen>
  );
}
