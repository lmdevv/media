import type { ContinueWatchingItem, TitleCard } from "@/lib/catalog";
import { LandscapeCard, PosterCard } from "@media/ui/components/media-card";
import { Link } from "@tanstack/react-router";

import { artworkUrl } from "@/lib/artwork";
import { episodeCode, facts, formatRemaining, progressFraction, titleFacts } from "@/lib/format";

import { usePrefetchTitle } from "./prefetch";

/** A 2:3 poster linking to the title's page. `subtitle` adds the grid's `2024 · 2h 46m` line. */
export function TitlePosterCard({
  title,
  subtitle,
  badge,
  className,
}: {
  readonly title: TitleCard;
  readonly subtitle?: string | undefined;
  readonly badge?: string | undefined;
  readonly className?: string;
}) {
  const prefetch = usePrefetchTitle(title.id);

  return (
    <PosterCard
      title={title.name}
      subtitle={subtitle}
      image={artworkUrl(title.artwork.poster, "poster")}
      badge={badge}
      className={className}
      render={<Link to="/title/$titleId" params={{ titleId: title.id }} {...prefetch} />}
    />
  );
}

/** A 16:9 card linking to the title's page, with `2016 · 1h 56m` under the name. */
export function TitleLandscapeCard({
  title,
  size = "desktop",
  className,
}: {
  readonly title: TitleCard;
  readonly size?: "desktop" | "phone";
  readonly className?: string;
}) {
  const prefetch = usePrefetchTitle(title.id);

  return (
    <LandscapeCard
      title={title.name}
      subtitle={titleFacts(title) || undefined}
      image={artworkUrl(title.artwork.backdrop ?? title.artwork.poster, "card")}
      size={size}
      className={className}
      render={<Link to="/title/$titleId" params={{ titleId: title.id }} {...prefetch} />}
    />
  );
}

interface ContinueText {
  readonly title: string;
  readonly subtitle: string | undefined;
}

const continueText = (item: ContinueWatchingItem, phone: boolean): ContinueText => {
  const left =
    item.progress === null || item.progress.watched
      ? undefined
      : formatRemaining(item.progress.durationMs - item.progress.positionMs);

  if (item.episode === null) return { title: item.title.name, subtitle: left };

  const code = episodeCode(item.episode);

  if (phone) {
    return {
      title: `${code} · ${item.reason === "next" ? "Next" : item.episode.name}`,
      subtitle: left ?? item.title.name,
    };
  }

  return {
    title: `${item.title.name} · ${code}`,
    subtitle: item.reason === "next" ? facts("Next", item.episode.name) : left,
  };
};

/** A Continue watching card: resumes the movie or episode in one click. */
export function ContinueCard({
  item,
  size = "desktop",
}: {
  readonly item: ContinueWatchingItem;
  readonly size?: "desktop" | "phone";
}) {
  const text = continueText(item, size === "phone");
  const progress = progressFraction(item.progress);

  return (
    <LandscapeCard
      title={text.title}
      subtitle={text.subtitle}
      image={artworkUrl(
        item.episode?.still ?? item.title.artwork.backdrop ?? item.title.artwork.poster,
        "card",
      )}
      progress={progress ?? undefined}
      size={size}
      render={
        <Link
          to="/watch/$titleId"
          params={{ titleId: item.title.id }}
          search={item.episode === null ? {} : { episodeId: item.episode.id }}
          aria-label={`Resume ${text.title}`}
        />
      }
    />
  );
}
