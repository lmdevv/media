import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from "@/components/ui/dialog";
import { Keys } from "@/components/ui/keys";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { SearchIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { useUi } from "@/components/shell/ui-state";
import { HOTKEYS } from "@/lib/hotkeys";

import { ItemRow } from "./item-row";
import { CHORDS, runnableAction } from "./menu-keys";
import type { Chord, ChordActions } from "./menu-keys";
import { Preview } from "./previews";
import { useMenuItems } from "./use-menu-items";

/**
 * The ⌘K command menu (Paper page 08): search your library (D38: songs, albums, artists, and your
 * playlists, never another client's catalog), open screens, and run the player's actions, with a
 * preview pane.
 */
export function CommandMenu() {
  const { commandOpen, setCommandOpen } = useUi();
  const close = useCallback(() => setCommandOpen(false), [setCommandOpen]);

  return (
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          aria-label="Command menu"
          className="fixed inset-x-2 top-2 z-50 flex max-h-dvh-inset-sm flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-text shadow-command outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 lg:inset-x-auto lg:top-27.5 lg:left-1/2 lg:w-195 lg:-translate-x-1/2"
        >
          {commandOpen ? <Menu onClose={close} /> : null}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

function Menu({ onClose }: { readonly onClose: () => void }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const { items, searching } = useMenuItems(deferred, onClose);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ readonly x: number; readonly y: number } | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const [runWhenShown, setRunWhenShown] = useState<string | null>(null);
  const [selectionQuery, setSelectionQuery] = useState(deferred);

  if (selectionQuery !== deferred) {
    setSelectionQuery(deferred);
    setActiveId(null);
    setDetail(false);
    setRunWhenShown(null);
  }

  const [first] = items;

  if (selectionQuery === deferred && activeId === null && !searching && first !== undefined) {
    setActiveId(first.id);
  }

  const active = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );

  const current = items[active];

  const select = useCallback((index: number) => setActiveId(items[index]?.id ?? null), [items]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const registered = useRef<{ readonly id: string; readonly actions: ChordActions } | null>(null);

  const [footer, setFooter] = useState<{
    readonly id: string;
    readonly label: string | null;
  } | null>(null);

  const currentId = current?.id ?? null;
  const footerLabel = footer !== null && footer.id === currentId ? footer.label : null;

  const registerActions = useCallback(
    (next: ChordActions | null) => {
      if (currentId === null) return;

      if (next === null) {
        if (registered.current?.id === currentId) registered.current = null;

        return;
      }

      registered.current = { id: currentId, actions: next };
      const label = next["command-menu.enter"]?.label ?? null;

      setFooter((previous) =>
        previous?.id === currentId && previous.label === label
          ? previous
          : { id: currentId, label },
      );
    },
    [currentId],
  );

  const run = useCallback(
    (chord: Chord) => {
      const shown = registered.current;

      if (shown !== null && shown.id === currentId) runnableAction(shown.actions, chord)?.run();
    },
    [currentId],
  );

  useEffect(() => {
    if (runWhenShown === null) return;

    if (runWhenShown !== currentId) {
      setRunWhenShown(null);

      return;
    }

    if (footer?.id !== runWhenShown) return;

    setRunWhenShown(null);
    run("command-menu.enter");
  }, [currentId, footer, run, runWhenShown]);

  const latest = useRef({ active, run });

  useEffect(() => {
    latest.current = { active, run };
  }, [active, run]);

  const onRowHover = useCallback(
    (index: number, event: MouseEvent<HTMLDivElement>) => {
      const last = pointer.current;
      pointer.current = { x: event.clientX, y: event.clientY };

      if (last !== null && (last.x !== event.clientX || last.y !== event.clientY)) select(index);
    },
    [select],
  );

  const onRowSelect = useCallback(
    (index: number) => {
      const item = items[index];

      if (item === undefined) return;

      select(index);

      if (item.kind === "now") setDetail(true);
      else if (index === latest.current.active) latest.current.run("command-menu.enter");
      else setRunWhenShown(item.id);
    },
    [items, select],
  );

  const back = useCallback(() => setDetail(false), []);

  const moveDown = () => select(Math.min(active + 1, items.length - 1));
  const moveUp = () => select(Math.max(active - 1, 0));

  useHotkeys(
    [
      { hotkey: "ArrowDown", callback: moveDown },
      { hotkey: "Control+J", callback: moveDown },
      { hotkey: "ArrowUp", callback: moveUp },
      { hotkey: "Control+P", callback: moveUp },
      ...CHORDS.map((chord) => ({
        hotkey: HOTKEYS[chord],
        callback: () => run(chord),
        options: { enabled: !searching },
      })),
    ],
    { target: input },
  );

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
          aria-label="Search your library"
          aria-activedescendant={current === undefined ? undefined : `command-${current.id}`}
          aria-controls="command-list"
          role="combobox"
          aria-expanded
          placeholder="Search your library…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-full min-w-0 grow bg-transparent font-sans text-lg/md text-text outline-none placeholder:text-text-muted"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={onClose}
          className="shrink-0"
          aria-label="Close"
        >
          <Keys hotkey="Escape" />
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
            tabIndex={-1}
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
                onHover={onRowHover}
                onSelect={onRowSelect}
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
                onClose={onClose}
                onBack={back}
                registerActions={registerActions}
              />
            )}
          </div>
        </div>
      )}

      <div className="hidden h-11 shrink-0 items-center gap-3.5 border-t border-border bg-surface pr-3 pl-5 lg:flex">
        <span className="grow font-mono text-xs/xs font-semibold text-text-muted">[music]</span>
        {footerLabel === null ? null : (
          <span className="flex items-center gap-2 font-sans text-sm/xs font-medium text-text">
            {footerLabel}
            <Keys hotkey={HOTKEYS["command-menu.enter"].defaultHotkey} />
          </span>
        )}
        <span aria-hidden className="h-4 w-px bg-border" />
        <span className="flex items-center gap-2 font-sans text-sm/xs text-text-muted">
          Close
          <Keys hotkey="Escape" />
        </span>
      </div>
    </>
  );
}
