import { Dialog } from "@base-ui/react/dialog";
import {
  commandMenuReducer,
  currentFrame,
  initialCommandMenuState,
  visibleCommands,
} from "@media/ui/lib/command-menu";
import type { CommandItem, CommandLeading, CommandPage } from "@media/ui/lib/command-menu";
import { cn } from "@media/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useReducer, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Keycaps } from "./keycap";
import { ProgressBar } from "./progress-bar";
import { Spinner } from "./spinner";

function Leading({
  leading,
  checked,
  running,
}: {
  readonly leading: CommandLeading | undefined;
  readonly checked: boolean;
  readonly running: boolean;
}) {
  return (
    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
      {checked ? (
        <CheckIcon className="size-4 text-text" strokeWidth={1.75} />
      ) : leading === undefined ? null : leading.kind === "icon" ? (
        <leading.icon className={cn("size-4", running ? "text-text" : "text-text-muted")} />
      ) : (
        <img
          src={leading.src}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-5 w-3.5 rounded-bar object-cover"
        />
      )}
    </span>
  );
}

function CommandRow({
  item,
  id,
  active,
  busy,
  onPoint,
  onChoose,
}: {
  readonly item: CommandItem;
  readonly id: string;
  readonly active: boolean;
  readonly busy: boolean;
  readonly onPoint: () => void;
  readonly onChoose: () => void;
}) {
  const running = item.progress !== undefined;
  const percent = running ? Math.round(Math.min(1, Math.max(0, item.progress ?? 0)) * 100) : 0;

  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-checked={item.checked}
      aria-busy={busy || undefined}
      data-active={active || undefined}
      onPointerMove={active ? undefined : onPoint}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={cn(
        "flex shrink-0 cursor-pointer flex-col justify-center gap-2 rounded-control px-3 font-sans",
        running ? "h-14" : "h-10",
        active && "bg-text/7",
      )}
    >
      <div className="flex items-center gap-3">
        <Leading leading={item.leading} checked={item.checked === true} running={running} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-small/5 text-text">{item.title}</span>
          {item.detail === undefined ? null : (
            <span className="truncate text-label/5 text-text-muted">{item.detail}</span>
          )}
        </span>
        {busy ? (
          <Spinner className="text-text-muted" />
        ) : running ? (
          <span className="shrink-0 font-mono text-caption/4 text-text-muted tabular-nums">
            {percent}%
          </span>
        ) : (
          <Keycaps keys={item.keycaps ?? []} />
        )}
      </div>
      {running ? (
        <ProgressBar
          value={item.progress ?? 0}
          tone="surface"
          thickness="thin"
          className="ml-8 w-auto"
        />
      ) : null}
    </div>
  );
}

/**
 * The ⌘K command menu, Linear/Raycast style: a borderless input with a red caret, small group
 * labels, rows with a fixed 20px icon or poster slot and keycaps where a shortcut exists, a filled
 * highlight, and one footer hint line. A {@link CommandSubmenu} replaces the list with its options
 * in the same panel.
 *
 * Keys: ↑/↓ or Ctrl+N/Ctrl+P move, Enter runs, Escape goes up a level (then closes), Backspace in
 * an empty input goes up a level. Typing filters rows fuzzily.
 *
 * Opening state resets each time the menu opens.
 *
 * @param root - The top-level list. Rebuild it as data changes; nested lists keep the options they
 *   had when opened.
 * @param onQueryChange - Called with the typed text and the list it filters, so the caller can
 *   supply `search`-scoped groups (such as title results) for it.
 * @param start - The id of a submenu in `root` to show when the menu opens, such as a "Switch
 *   profile" list opened by its own shortcut. Going back reaches the root list.
 * @param container - Where the menu renders, such as the player while it is full screen, where
 *   nothing outside the full-screen element shows; the body when undefined.
 */
export function CommandMenu({
  open,
  onOpenChange,
  root,
  onQueryChange,
  start,
  container,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly root: CommandPage;
  readonly onQueryChange?: (query: string, page: CommandPage) => void;
  readonly start?: string | undefined;
  readonly container?: HTMLElement | undefined;
}) {
  const [state, dispatch] = useReducer(commandMenuReducer, initialCommandMenuState);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);

    if (open) dispatch({ type: "reset" });
  }

  const openings = useRef(0);

  useEffect(() => {
    if (open) openings.current += 1;
  }, [open]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const frame = currentFrame(state);
  const page = frame.page ?? root;
  const nested = state.nested.length > 0;
  const visible = visibleCommands(page, frame.query);
  const count = visible.items.length;
  const active = count === 0 ? -1 : Math.min(frame.active, count - 1);
  const activeId = active === -1 ? undefined : `${listboxId}-${active}`;

  useEffect(() => {
    if (activeId !== undefined)
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const findStart = useEffectEvent((id: string) =>
    root.groups.flatMap((group) => group.items).find((candidate) => candidate.id === id),
  );

  useEffect(() => {
    if (!open || start === undefined) return;

    const item = findStart(start);

    if (item?.kind !== "submenu") return;

    dispatch({ type: "reset" });
    dispatch({ type: "open", page: item.page });
  }, [open, start]);

  const setQuery = (query: string, on: CommandPage): void => {
    dispatch({ type: "query", query });
    onQueryChange?.(query, on);
  };

  const back = (): void => {
    const parent = state.nested.at(-2);

    dispatch({ type: "back" });
    onQueryChange?.(parent?.query ?? state.root.query, parent?.page ?? root);
  };

  const choose = (item: CommandItem | undefined): void => {
    if (item === undefined || busyId !== null) return;

    if (item.kind === "submenu") {
      dispatch({ type: "open", page: item.page });
      onQueryChange?.("", item.page);

      return;
    }

    const opening = openings.current;

    const settle = (close: boolean): void => {
      setBusyId(null);

      if (close && item.keepOpen !== true && openings.current === opening) onOpenChange(false);
    };

    const result = item.perform();

    if (result instanceof Promise) {
      setBusyId(item.id);
      void result.then(
        () => settle(true),
        () => settle(false),
      );

      return;
    }

    settle(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
    const key = event.key.toLowerCase();

    if (event.key === "ArrowDown" || (ctrlOnly && key === "n")) {
      event.preventDefault();
      dispatch({ type: "move", by: 1, count });
    } else if (event.key === "ArrowUp" || (ctrlOnly && key === "p")) {
      event.preventDefault();
      dispatch({ type: "move", by: -1, count });
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(visible.items[active]);
    } else if (event.key === "Backspace" && frame.query === "" && nested) {
      event.preventDefault();
      back();
    }
  };

  let index = -1;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key" && nested) {
          details.cancel();
          back();

          return;
        }

        onOpenChange(next);
      }}
    >
      <Dialog.Portal container={container}>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          initialFocus={inputRef}
          aria-label="Command menu"
          data-slot="command-menu"
          className="fixed top-4 left-1/2 z-50 flex w-160 max-w-[calc(100vw-var(--spacing-8))] -translate-x-1/2 flex-col overflow-hidden rounded-card border border-text/8 bg-surface font-sans shadow-overlay transition-[opacity,scale] duration-150 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 md:top-35"
        >
          <div className="flex h-16 shrink-0 items-center gap-3 border-b border-hairline px-5">
            {page.breadcrumb === undefined ? null : (
              <span className="flex h-6 shrink-0 items-center rounded-inner bg-text/7 px-2 text-label/4 text-text">
                {page.breadcrumb}
              </span>
            )}
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              aria-label={page.breadcrumb ?? "Search or jump to"}
              autoComplete="off"
              spellCheck={false}
              placeholder={page.placeholder}
              value={frame.query}
              onChange={(event) => setQuery(event.target.value, page)}
              onKeyDown={onKeyDown}
              className="h-6 min-w-0 flex-1 bg-transparent text-command/6 tracking-tight text-text caret-accent outline-none placeholder:text-text-muted"
            />
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-label={page.breadcrumb ?? "Commands"}
            className="flex max-h-[min(var(--spacing-command-list),calc(100dvh-var(--spacing-56)))] flex-col overflow-y-auto px-2 pt-2 pb-1 scrollbar-none"
          >
            {visible.noResults ? (
              <p className="px-3 pt-5 pb-4 text-small/5 text-text-muted">
                No results for “{frame.query.trim()}”
              </p>
            ) : null}
            {visible.groups.map((group) => {
              const labelId = `${listboxId}-${group.id}`;

              return (
                <div
                  key={group.id}
                  role="group"
                  aria-labelledby={group.label === undefined ? undefined : labelId}
                  className="flex flex-col not-first:pt-2"
                >
                  {group.label === undefined ? null : (
                    <div
                      id={labelId}
                      className="px-3 pt-2.5 pb-1.5 text-caption/4 font-medium text-text-muted"
                    >
                      {group.label}
                    </div>
                  )}
                  {group.items.map((item) => {
                    index += 1;

                    const position = index;

                    return (
                      <CommandRow
                        key={item.id}
                        id={`${listboxId}-${position}`}
                        item={item}
                        active={position === active}
                        busy={busyId === item.id}
                        onPoint={() => dispatch({ type: "point", index: position })}
                        onChoose={() => choose(item)}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div
            aria-hidden
            className="flex shrink-0 items-center gap-5 px-5 pt-3 pb-3.5 font-mono text-micro/3.5 text-text-muted"
          >
            <span>↵ {nested ? "Select" : "Open"}</span>
            <span>↑↓ Navigate</span>
            <span>{nested ? "⌫ Back" : "esc Close"}</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
