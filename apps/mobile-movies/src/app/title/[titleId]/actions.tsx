import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Check, EyeOff, Minus, Plus, RotateCcw, Share as ShareIcon } from "lucide-react-native";
import { Share } from "react-native";

import { titleIdParam } from "@/components/title/route-params";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { DownloadRow } from "@/components/title/download-row";
import { defaultVersion, playAction, watchedMarks } from "@/components/title/title-model";
import { useMyListToggle, useRunner } from "@/components/title/use-title-actions";
import { ListRow } from "@/components/ui/list-row";
import type { TitleDetail } from "@/lib/catalog";
import { describeFailure } from "@/lib/failure";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

function TitleActions({ title }: { readonly title: TitleDetail }) {
  const { moviesUrl } = useServer();
  const myList = useMyListToggle(title.id, title.inMyList);
  const { markWatched, markUnwatched } = usePlatform().movies.history;
  const mark = useRunner();
  const exit = useSheetExit();
  const marks = watchedMarks(title);
  const play = playAction(title);

  const file = title.kind === "movie" ? defaultVersion(title.versions) : undefined;

  const setWatched = async (watched: boolean) => {
    const args = { titleId: title.id };
    const done = await mark.run(() => (watched ? markWatched(args) : markUnwatched(args)));

    if (done) exit.close();
  };

  const toggleList = async () => {
    if (await myList.toggle()) exit.close();
  };

  const share = async () => {
    await Share.share({ message: title.name, url: `${moviesUrl}/title/${title.id}` }).catch(
      () => undefined,
    );
    exit.close();
  };

  return (
    <Sheet title={title.name} error={myList.error ?? mark.error} exit={exit}>
      {play.available && file !== undefined ? (
        <DownloadRow target={{ titleId: title.id, fileId: file.id }} exit={exit} />
      ) : null}
      <ListRow
        icon={myList.inList ? Minus : Plus}
        title={myList.inList ? "Remove from My List" : "Add to My List"}
        disabled={myList.busy}
        onPress={() => void toggleList()}
      />
      {play.resuming && play.available ? (
        <ListRow
          icon={RotateCcw}
          title="Play from Beginning"
          onPress={() =>
            exit.leaveFor(
              watchHref({ titleId: title.id, episodeId: play.episodeId, start: "beginning" }),
            )
          }
        />
      ) : null}
      {marks.markWatched ? (
        <ListRow
          icon={Check}
          title="Mark as Watched"
          disabled={mark.busy}
          onPress={() => void setWatched(true)}
        />
      ) : null}
      {marks.markUnwatched ? (
        <ListRow
          icon={EyeOff}
          title="Mark as Unwatched"
          disabled={mark.busy}
          onPress={() => void setWatched(false)}
        />
      ) : null}
      <ListRow icon={ShareIcon} title="Share" onPress={() => void share()} />
    </Sheet>
  );
}

export default function TitleActionsSheet() {
  const params = useLocalSearchParams<{ titleId: string }>();
  const platform = usePlatform();
  const titleId = titleIdParam(params.titleId);

  const title = usePlatformQuery(
    platform.movies.titles.get,
    ...(titleId === null ? (["skip"] as const) : [{ titleId }]),
  );

  if (titleId === null) return <Sheet title="Title" error="This title isn't here." />;

  if (title.status !== "success") {
    return (
      <Sheet
        title="Title"
        loading={title.status === "loading"}
        error={title.status === "error" ? describeFailure(title.error) : null}
      />
    );
  }

  return <TitleActions title={title.data} />;
}
