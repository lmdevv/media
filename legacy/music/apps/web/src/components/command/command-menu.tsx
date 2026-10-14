import { AlbumId, ArtistId, PlaylistId } from "@music/commands/ids";
import { usePlayer } from "@music/player/react";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from "@music/ui/components/dialog";
import { Kbd } from "@music/ui/components/kbd";
import { Spinner } from "@music/ui/components/spinner";
import { cn } from "@music/ui/lib/utils";
import { useParams } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { SearchIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { useUi } from "@/components/shell/ui-state";

import type { MenuContext } from "./args-form";
import { ItemRow } from "./item-row";
import { primaryLabel } from "./items";
import { menuKeyOf } from "./menu-keys";
import { Preview } from "./previews";
import { useMenuItems } from "./use-menu-items";

const decodeAlbumId = Schema.decodeUnknownOption(AlbumId);

const decodeArtistId = Schema.decodeUnknownOption(ArtistId);

const decodePlaylistId = Schema.decodeUnknownOption(PlaylistId);

/** What the screen behind the menu shows, from the current route's parameters. */
const useMenuContext = (): MenuContext => {
  const params = useParams({ strict: false });

  return {
    albumId: Option.getOrNull(decodeAlbumId(params.albumId)),
    artistId: Option.getOrNull(decodeArtistId(params.artistId)),
    playlistId: Option.getOrNull(decodePlaylistId(params.playlistId)),
  };
};

/**
 * The ⌘K command menu (Paper page 08): search your library and run any command from the registry
 * that applies here, with a preview pane and an inline form for commands that take arguments.
 */
export function CommandMenu() {
  const { commandOpen, setCommandOpen } = useUi();

  return (
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          aria-label="Command menu"
          className="fixed inset-x-2 top-2 z-50 flex max-h-dvh-inset-sm flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-text shadow-command outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 lg:inset-x-auto lg:top-27.5 lg:left-1/2 lg:w-195 lg:-translate-x-1/2"
        >
          {commandOpen ? <Menu onClose={() => setCommandOpen(false)} /> : null}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

function Menu({ onClose }: { readonly onClose: () => void }) {
  const player = usePlayer();
  const context = useMenuContext();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const { items, searching } = useMenuItems(deferred, onClose);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** Where the pointer last was over the list, or null before it first moved there. */
  const pointer = useRef<{ readonly x: number; readonly y: number } | null>(null);

  // The menu exists to type into, so focus starts in the field.
  useEffect(() => {
    input.current?.focus();
  }, []);

  // A row clicked while another was selected: it runs once its own preview registers.
  const [runWhenShown, setRunWhenShown] = useState<string | null>(null);

  useEffect(() => {
    setActiveId(null);
    setDetail(false);
    setRunWhenShown(null);
  }, [deferred]);

  // Once results for the query settle, the selection follows its item, so results arriving later
  // never move what Enter runs.
  useEffect(() => {
    const [first] = items;

    if (activeId === null && !searching && first !== undefined) setActiveId(first.id);
  }, [activeId, items, searching]);

  const active = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );

  const current = items[active];
  const select = (index: number) => setActiveId(items[index]?.id ?? null);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The shown preview's primary action, tagged with its row so a stale one never runs.
  const [primary, setPrimary] = useState<{ readonly id: string; readonly run: () => void } | null>(
    null,
  );

  const currentId = current?.id ?? null;
  const runPrimary = primary !== null && primary.id === currentId ? primary.run : null;

  const registerPrimary = useCallback(
    (run: (() => void) | null) => {
      if (currentId === null) return;

      setPrimary((previous) =>
        run === null ? (previous?.id === currentId ? null : previous) : { id: currentId, run },
      );
    },
    [currentId],
  );

  useEffect(() => {
    if (runWhenShown === null) return;

    // The selection moved off the clicked row before its preview registered: nothing runs, and
    // coming back to that row later doesn't run it either.
    if (runWhenShown !== currentId) {
      setRunWhenShown(null);

      return;
    }

    if (primary?.id !== runWhenShown) return;

    setRunWhenShown(null);
    primary.run();
  }, [currentId, primary, runWhenShown]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const key = menuKeyOf(event.nativeEvent);

    if (key === null) return;

    event.preventDefault();

    if (key === "next") select(Math.min(active + 1, items.length - 1));
    else if (key === "previous") select(Math.max(active - 1, 0));
    // While a new query's results load, the rows are the previous query's, so Enter waits.
    else if (!searching) runPrimary?.();
  };

  const empty = items.length === 0 && !searching;

  return (
    <>
      <div className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
        {searching ? (
          <Spinner className="size-5 text-text-muted" label="Searching" />
        ) : (
          <SearchIcon aria-hidden className="size-5 shrink-0 text-text-muted" />
        )}
        <input
          ref={input}
          aria-label="Search your library or type a command"
          aria-activedescendant={current === undefined ? undefined : `command-${current.id}`}
          aria-controls="command-list"
          role="combobox"
          aria-expanded
          placeholder="Search your library or type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 grow bg-transparent font-sans text-lg/md text-text outline-none placeholder:text-text-muted"
        />
        <button type="button" onClick={onClose} className="shrink-0" aria-label="Close">
          <Kbd>ESC</Kbd>
        </button>
      </div>

      {empty ? (
        <div className="flex h-70 flex-col items-center justify-center gap-2.5 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-surface">
            <SearchIcon aria-hidden className="size-5.5 text-text-muted" />
          </span>
          <span className="font-sans text-md/base font-semibold text-text">
            Nothing matches “{deferred}”
          </span>
          <span className="max-w-95 font-sans text-sm/xs text-text-muted">
            It isn't in your library or the command list. Try fewer words.
          </span>
        </div>
      ) : (
        <div className="flex min-h-0 grow lg:h-110 lg:grow-0">
          <div
            ref={list}
            id="command-list"
            role="listbox"
            aria-label="Results and commands"
            className={cn(
              "flex w-full shrink-0 flex-col gap-px overflow-y-auto p-2 lg:w-90 lg:border-r lg:border-border",
              detail && "max-lg:hidden",
            )}
          >
            {items.map((item, index) => (
              <ItemRow
                key={item.id}
                item={item}
                index={index}
                active={index === active}
                header={
                  index === 0 || items[index - 1]?.section !== item.section ? item.section : null
                }
                onHover={(event) => {
                  // Browsers report rows moving under a resting pointer (the list filling in or
                  // scrolling to the selection) as mouse movement. Only a pointer that moved
                  // selects, so a resting mouse never takes the row the keyboard chose.
                  const last = pointer.current;
                  pointer.current = { x: event.clientX, y: event.clientY };

                  if (last !== null && (last.x !== event.clientX || last.y !== event.clientY)) {
                    select(index);
                  }
                }}
                onSelect={() => {
                  select(index);

                  if (item.kind === "command" && item.fields.length > 0) setDetail(true);
                  else if (item.kind === "now") setDetail(true);
                  // A tap can select and click in one go; the old row's action must not run.
                  else if (index === active) runPrimary?.();
                  else setRunWhenShown(item.id);
                }}
              />
            ))}
          </div>
          <div
            className={cn(
              "min-w-0 grow overflow-y-auto",
              detail ? "flex" : "max-lg:hidden lg:flex",
            )}
          >
            {current === undefined ? null : (
              <Preview
                key={current.id}
                item={current}
                context={context}
                onClose={onClose}
                onBack={() => setDetail(false)}
                registerPrimary={registerPrimary}
              />
            )}
          </div>
        </div>
      )}

      <div className="hidden h-11 shrink-0 items-center gap-3.5 border-t border-border bg-surface pr-3 pl-5 lg:flex">
        <span className="grow font-mono text-xs/xs font-semibold text-text-muted">[music]</span>
        {current === undefined ? null : (
          <span className="flex items-center gap-2 font-sans text-sm/xs font-medium text-text">
            {primaryLabel(current, player.status === "playing")}
            <Kbd>↵</Kbd>
          </span>
        )}
        <span aria-hidden className="h-4 w-px bg-border" />
        <span className="flex items-center gap-2 font-sans text-sm/xs text-text-muted">
          Close
          <Kbd>ESC</Kbd>
        </span>
      </div>
    </>
  );
}
