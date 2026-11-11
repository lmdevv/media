import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";

import { seasonParam, titleIdParam } from "@/components/title/route-params";
import { Sheet } from "@/components/title/sheet";
import { seasonDetail } from "@/components/title/title-model";
import { ListRow } from "@/components/ui/list-row";
import { describeFailure } from "@/lib/failure";

export default function Seasons() {
  const params = useLocalSearchParams<{ titleId: string; season?: string }>();
  const platform = usePlatform();
  const titleId = titleIdParam(params.titleId);
  const selected = seasonParam(params.season);

  const title = usePlatformQuery(
    platform.movies.titles.get,
    ...(titleId === null ? (["skip"] as const) : [{ titleId }]),
  );

  if (titleId === null) return <Sheet title="Seasons" error="This show isn't here." />;

  return (
    <Sheet
      title="Seasons"
      loading={title.status === "loading"}
      error={title.status === "error" ? describeFailure(title.error) : null}
    >
      {title.status === "success"
        ? title.data.seasons.map((season) => (
            <ListRow
              key={season.id}
              title={season.name}
              detail={seasonDetail(season, season.seasonNumber === selected)}
              onPress={() =>
                router.dismissTo({
                  pathname: "/title/[titleId]",
                  params: { titleId, season: String(season.seasonNumber) },
                })
              }
            />
          ))
        : null}
    </Sheet>
  );
}
