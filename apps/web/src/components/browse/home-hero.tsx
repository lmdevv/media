import type { ProfileId } from "@media/contracts/ids";
import type { TitleCard, TitleDetail } from "@media/contracts/models/catalog";
import { useCommandQuery } from "@media/sdk/react";
import { Badge } from "@media/ui/components/badge";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { Hero, HeroCard } from "@media/ui/components/hero";
import { PlayGlyph } from "@media/ui/components/icons";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { CheckIcon, InfoIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { artworkUrl } from "@/lib/artwork";
import { facts, formatRuntime, plural } from "@/lib/format";
import { fileBadges } from "@/lib/media-facts";

import { playTarget, useMyListToggle, watchSearch } from "./play-target";
import { newBadge } from "./new-badge";

const titleArt = (title: TitleCard, phone: boolean): ReactNode => {
  const logo = artworkUrl(title.artwork.logo, "card");

  if (logo === undefined) return undefined;

  return (
    <img
      src={logo}
      alt={title.name}
      className={cn(
        "object-contain object-left",
        phone ? "mx-auto h-16 max-w-60" : "h-40 max-w-140",
      )}
    />
  );
};

/** The billboard on Home for `featured`. */
export function HomeHero({
  featured,
  profileId,
  phone,
}: {
  readonly featured: TitleCard;
  readonly profileId: ProfileId;
  readonly phone: boolean;
}) {
  const detail = useCommandQuery("titles.get", { profileId, titleId: featured.id });
  const loaded = detail.status === "success" ? detail.data : null;

  return phone ? (
    <PhoneHero featured={featured} detail={loaded} profileId={profileId} />
  ) : (
    <DesktopHero featured={featured} detail={loaded} />
  );
}

function DesktopHero({
  featured,
  detail,
}: {
  readonly featured: TitleCard;
  readonly detail: TitleDetail | null;
}) {
  const target = detail === null ? null : playTarget(detail);
  const file = detail?.files.find((candidate) => !candidate.missing);
  const badges = file === undefined ? [] : fileBadges(file).slice(0, 2);

  return (
    <Hero
      title={featured.name}
      titleArt={titleArt(featured, false)}
      backdrop={artworkUrl(featured.artwork.backdrop, "backdrop")}
      highlight={newBadge(featured, Date.now()) === undefined ? undefined : "New this week"}
      facts={facts(
        featured.year,
        featured.kind === "show"
          ? detail === null
            ? null
            : plural(detail.seasons.length, "season", "seasons")
          : featured.runtimeMs === null
            ? null
            : formatRuntime(featured.runtimeMs),
        featured.certification,
      )}
      badges={badges.map((badge) => (
        <Badge key={badge}>{badge}</Badge>
      ))}
      overview={detail?.overview ?? undefined}
      actions={
        <>
          {featured.available ? (
            <Link
              to="/watch/$titleId"
              params={{ titleId: featured.id }}
              search={watchSearch(target?.episodeId, false)}
              className={buttonVariants({ size: "lg" })}
            >
              <PlayGlyph />
              {target?.resuming === true ? "Resume" : "Play"}
            </Link>
          ) : null}
          <Link
            to="/title/$titleId"
            params={{ titleId: featured.id }}
            className={buttonVariants({ variant: "secondary", size: "lg" })}
          >
            <InfoIcon strokeWidth={1.75} aria-hidden />
            More info
          </Link>
        </>
      }
    />
  );
}

function PhoneHero({
  featured,
  detail,
  profileId,
}: {
  readonly featured: TitleCard;
  readonly detail: TitleDetail | null;
  readonly profileId: ProfileId;
}) {
  const target = detail === null ? null : playTarget(detail);

  const myList = useMyListToggle(profileId, featured.id, detail?.inMyList ?? false, featured.name);

  return (
    <div className="px-4">
      <HeroCard
        title={featured.name}
        titleArt={titleArt(featured, true)}
        backdrop={artworkUrl(featured.artwork.poster ?? featured.artwork.backdrop, "card")}
        facts={facts(...featured.genres.slice(0, 2), featured.year)}
        actions={
          <>
            {featured.available ? (
              <Link
                to="/watch/$titleId"
                params={{ titleId: featured.id }}
                search={watchSearch(target?.episodeId, false)}
                className={buttonVariants({ size: "pill" })}
              >
                <PlayGlyph className="size-4" />
                {target?.resuming === true ? "Resume" : "Play"}
              </Link>
            ) : (
              <Link
                to="/title/$titleId"
                params={{ titleId: featured.id }}
                className={buttonVariants({ size: "pill" })}
              >
                More info
              </Link>
            )}
            <Button
              variant="glass"
              size="pill"
              aria-pressed={myList.inList}
              disabled={detail === null}
              onClick={() => void myList.toggle()}
            >
              {myList.inList ? (
                <CheckIcon strokeWidth={2} aria-hidden />
              ) : (
                <PlusIcon strokeWidth={2} aria-hidden />
              )}
              My List
            </Button>
          </>
        }
      />
    </div>
  );
}
