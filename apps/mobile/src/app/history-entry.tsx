import { useCommand } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Check, Play, RotateCcw, Trash2 } from "lucide-react-native";

import { episodeIdParam, titleIdParam } from "@/components/title/route-params";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { useRunner } from "@/components/title/use-title-actions";
import { ListRow } from "@/components/ui/list-row";
import { watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";

export default function HistoryEntryActions() {
  const params = useLocalSearchParams<{ name?: string; left?: string; watched?: string }>();
  const raw = useLocalSearchParams();
  const titleId = titleIdParam(raw["titleId"]);
  const episodeId = episodeIdParam(raw["episodeId"]) ?? undefined;
  const watched = params.watched === "1";
  const { profile } = useActiveProfile();
  const markWatched = useCommand("history.markWatched");
  const markUnwatched = useCommand("history.markUnwatched");
  const runner = useRunner();
  const exit = useSheetExit();

  if (titleId === null) return <Sheet title="Not Found" exit={exit} />;

  const target =
    episodeId === undefined
      ? { profileId: profile.id, titleId }
      : { profileId: profile.id, titleId, episodeId };

  const change = async <A,>(work: () => Promise<A>) => {
    if (await runner.run(work)) exit.close();
  };

  return (
    <Sheet title={params.name ?? ""} error={runner.error} exit={exit}>
      {watched ? (
        <ListRow
          icon={RotateCcw}
          title="Play Again"
          onPress={() => exit.leaveFor(watchHref({ titleId, episodeId, start: "beginning" }))}
        />
      ) : (
        <ListRow
          icon={Play}
          iconFilled
          title="Resume"
          {...(params.left === undefined || params.left === "" ? {} : { detail: params.left })}
          onPress={() => exit.leaveFor(watchHref({ titleId, episodeId }))}
        />
      )}
      {watched ? null : (
        <ListRow
          icon={Check}
          title="Mark as Watched"
          disabled={runner.busy}
          onPress={() => void change(() => markWatched(target))}
        />
      )}
      <ListRow
        icon={Trash2}
        title="Remove from History"
        disabled={runner.busy}
        onPress={() => void change(() => markUnwatched(target))}
      />
    </Sheet>
  );
}
