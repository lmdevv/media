import type { TitleDetail } from "@media/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Check, EyeOff, Minus, Plus, RotateCcw, Share as ShareIcon } from "lucide-react-native";
import { Share } from "react-native";

import { titleIdParam } from "@/components/title/route-params";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { playAction, watchedMarks } from "@/components/title/title-model";
import { useDownloadAction } from "@/components/downloads/use-download-action";
import { useMyListToggle, useRunner } from "@/components/title/use-title-actions";
import { ListRow } from "@/components/ui/list-row";
import { describeFailure } from "@/lib/failure";
import { watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

function TitleActions({ title }: { readonly title: TitleDetail }) {
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const myList = useMyListToggle(profile.id, title.id, title.inMyList);
  const markWatched = useCommand("history.markWatched");
  const markUnwatched = useCommand("history.markUnwatched");
  const mark = useRunner();
  const exit = useSheetExit();
  const marks = watchedMarks(title);
  const play = playAction(title);

  const download = useDownloadAction({
    profileId: profile.id,
    titleId: title.id,
    episodeId: null,
    fileId: null,
    titleName: title.name,
    episodeName: null,
    seasonNumber: null,
    episodeNumber: null,
    runtimeMs: title.runtimeMs,
    artwork: title.artwork.backdrop ?? title.artwork.poster,
  });

  const setWatched = async (watched: boolean) => {
    const args = { profileId: profile.id, titleId: title.id };
    const done = await mark.run(() => (watched ? markWatched(args) : markUnwatched(args)));

    if (done) exit.close();
  };

  const toggleList = async () => {
    if (await myList.toggle()) exit.close();
  };

  const share = async () => {
    await Share.share({ message: title.name, url: `${mediaUrl}/title/${title.id}` }).catch(
      () => undefined,
    );
    exit.close();
  };

  return (
    <Sheet title={title.name} error={myList.error ?? mark.error} exit={exit}>
      {title.kind === "movie" && play.available && download !== null ? (
        <ListRow
          icon={download.icon}
          title={download.title}
          detail={download.detail}
          onPress={() => {
            const page = download.press();

            if (page === null) exit.close();
            else exit.leaveFor(page);
          }}
        />
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
  const { profile } = useActiveProfile();
  const titleId = titleIdParam(params.titleId);

  const title = useCommandQuery(
    "titles.get",
    titleId === null ? "skip" : { profileId: profile.id, titleId },
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
