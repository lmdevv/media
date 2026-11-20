import type {
  ContinueWatchingItem,
  Episode,
  SeasonEpisode,
  TitleCard,
  TitleId,
} from "@/lib/catalog";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLinkItem,
} from "@media/ui/components/context-menu";
import { PlayGlyph } from "@media/ui/components/icons";
import { toastFailure } from "@media/ui/lib/failure";
import { Link } from "@tanstack/react-router";
import { CheckIcon, CircleCheckIcon, InfoIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { continueMenu, episodeMenu, titleMenu } from "./menu-items";
import type { MenuItem } from "./menu-items";
import { useMyListToggle, watchSearch } from "./play-target";

/** The rows of a title's menu. `name` is what toasts call the title or episode. */
function MenuRows({
  titleId,
  titleName,
  name,
  items,
}: {
  readonly titleId: TitleId;
  readonly titleName: string;
  readonly name: string;
  readonly items: ReadonlyArray<MenuItem>;
}) {
  const platform = usePlatform();
  const { markWatched, markUnwatched } = platform.movies.history;
  const listed = items.some((item) => item.kind === "myList" && item.inList);
  const myList = useMyListToggle(titleId, listed, titleName);

  const mark = async (item: Extract<MenuItem, { kind: "mark" }>): Promise<void> => {
    const args =
      item.episodeId === undefined ? { titleId } : { titleId, episodeId: item.episodeId };

    try {
      await (item.watched ? markWatched(args) : markUnwatched(args));
      toast.success(`Marked ${name} as ${item.watched ? "watched" : "unwatched"}`);
    } catch (cause) {
      toastFailure(cause);
    }
  };

  return items.map((item) => {
    if (item.kind === "play") {
      return (
        <ContextMenuLinkItem
          key="play"
          render={
            <Link
              to="/watch/$titleId"
              params={{ titleId }}
              search={watchSearch(item.episodeId, false)}
            />
          }
        >
          <PlayGlyph className="size-4" />
          {item.label}
        </ContextMenuLinkItem>
      );
    }

    if (item.kind === "myList") {
      return (
        <ContextMenuItem key="myList" onClick={() => void myList.toggle()}>
          {item.inList ? <CheckIcon aria-hidden /> : <PlusIcon aria-hidden />}
          {item.inList ? "Remove from My List" : "Add to My List"}
        </ContextMenuItem>
      );
    }

    if (item.kind === "mark") {
      return (
        <ContextMenuItem key={`mark-${item.watched}`} onClick={() => void mark(item)}>
          {item.watched ? <CircleCheckIcon aria-hidden /> : <RotateCcwIcon aria-hidden />}
          {item.watched ? "Mark as watched" : "Mark as unwatched"}
        </ContextMenuItem>
      );
    }

    return (
      <ContextMenuLinkItem
        key="goToTitle"
        render={<Link to="/title/$titleId" params={{ titleId }} />}
      >
        <InfoIcon aria-hidden />
        Go to title
      </ContextMenuLinkItem>
    );
  });
}

/** The title's page, which the menu reads My List and progress from. */
const useDetail = (titleId: TitleId) => {
  const platform = usePlatform();
  const detail = usePlatformQuery(platform.movies.titles.get, { titleId });

  return detail.status === "success" ? detail.data : undefined;
};

function TitleRows({ title }: { readonly title: Pick<TitleCard, "id" | "name" | "available"> }) {
  const detail = useDetail(title.id);

  return (
    <MenuRows
      titleId={title.id}
      titleName={title.name}
      name={title.name}
      items={titleMenu(title.available, detail)}
    />
  );
}

function ContinueRows({
  item,
  name,
}: {
  readonly item: ContinueWatchingItem;
  readonly name: string;
}) {
  const detail = useDetail(item.title.id);

  return (
    <MenuRows
      titleId={item.title.id}
      titleName={item.title.name}
      name={name}
      items={continueMenu(item, detail?.inMyList)}
    />
  );
}

/** A poster or landscape card's menu: play, My List, mark watched or unwatched, go to title. */
export function TitleMenu({
  title,
  children,
}: {
  readonly title: Pick<TitleCard, "id" | "name" | "available">;
  readonly children: ReactNode;
}) {
  return <ContextMenu content={<TitleRows title={title} />}>{children}</ContextMenu>;
}

/** A Continue watching card's menu, aimed at its movie or the episode in progress. */
export function ContinueMenu({
  item,
  name,
  children,
}: {
  readonly item: ContinueWatchingItem;
  readonly name: string;
  readonly children: ReactNode;
}) {
  return <ContextMenu content={<ContinueRows item={item} name={name} />}>{children}</ContextMenu>;
}

/** An episode row's menu on its show's page: play it, and mark it watched or unwatched. */
export function EpisodeMenu({
  show,
  episode,
  children,
}: {
  readonly show: { readonly id: TitleId; readonly name: string };
  readonly episode: SeasonEpisode | Episode;
  readonly children: ReactNode;
}) {
  return (
    <ContextMenu
      content={
        <MenuRows
          titleId={show.id}
          titleName={show.name}
          name={episode.name}
          items={episodeMenu(episode)}
        />
      }
    >
      {children}
    </ContextMenu>
  );
}
