/**
 * G10 · Content · access removed: a playlist, album, or artist that was deleted, unshared, or
 * moved out of the viewer's libraries while they had it open. The copy stays deliberately vague,
 * so it never says whether the record exists.
 */
import { router } from "expo-router";
import { CircleAlert, Lock } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";
import type { Unavailable } from "@/lib/detail-state";

/** What the page was showing. */
export type ContentKind = "playlist" | "album" | "artist";

const TITLES = { playlist: "Playlist", album: "Album", artist: "Artist" } as const;

const backToLibrary = () => router.navigate("/(app)/(tabs)/(library)");

/** G10 as a page, or the failure with the same way out. */
export function ContentUnavailable({
  state,
  kind,
}: {
  readonly state: Unavailable;
  readonly kind: ContentKind;
}) {
  const back = <Button label="Back to library" onPress={backToLibrary} />;

  if (state.kind === "failed") {
    return (
      <Page title={TITLES[kind]}>
        <EmptyState
          icon={CircleAlert}
          title={`Couldn’t load\nthis ${kind}.`}
          body={state.message}
          primary={back}
        />
      </Page>
    );
  }

  return (
    <Page title="Unavailable">
      <EmptyState
        icon={Lock}
        title={"This music\nisn’t available."}
        body={`The owner may have removed this ${kind}\nor changed your library access.`}
        primary={back}
      />
    </Page>
  );
}
