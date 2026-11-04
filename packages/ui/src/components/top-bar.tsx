import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@media/ui/lib/utils";
import { SearchIcon, UsersIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Wordmark } from "./wordmark";

/**
 * The desktop top bar: wordmark and section links on the left; search, the room pill and the
 * avatar on the right.
 *
 * @param overMedia - The bar floats transparent over a hero backdrop with white chrome. Otherwise it
 *   sits on the page color and follows the theme.
 * @param brand - Replaces the wordmark, for example with a link to Home that wraps it.
 */
export function TopBar({
  nav,
  actions,
  brand,
  overMedia = false,
  className,
}: {
  readonly nav?: ReactNode;
  readonly actions?: ReactNode;
  readonly brand?: ReactNode;
  readonly overMedia?: boolean;
  readonly className?: string;
}) {
  return (
    <header
      data-slot="top-bar"
      className={cn(
        "flex h-17 w-full items-center justify-between gap-6 font-sans",
        overMedia ? "on-media" : "text-text",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-9">
        {brand ?? <Wordmark />}
        {nav === undefined ? null : (
          <nav aria-label="Sections" className="flex items-center gap-5.5">
            {nav}
          </nav>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-4.5">{actions}</div>
      )}
    </header>
  );
}

/**
 * A section link in the {@link TopBar}. Pass the router's link through `render`; `active` marks the
 * current section (bold, full contrast, `aria-current="page"`).
 */
export function TopBarLink({
  active = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & { readonly active?: boolean }) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        "aria-current": active ? "page" : undefined,
        className: cn(
          "rounded-bar text-small/4.5 whitespace-nowrap transition-colors",
          active ? "font-semibold text-text" : "font-medium text-text-muted hover:text-text",
          className,
        ),
      },
      props,
    ),
  });
}

/**
 * The single "Search ⌘K" field. It is a button that opens the command menu, not a text input.
 *
 * @param keycaps - The shortcut as shown on this platform, such as `⌘K` or `Ctrl K`.
 */
export function SearchTrigger({
  keycaps,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { readonly keycaps: string }) {
  return (
    <button
      data-slot="search-trigger"
      type={type}
      aria-haspopup="dialog"
      className={cn(
        "flex h-8.5 w-55 shrink-0 cursor-pointer items-center gap-2 rounded-control bg-text/10 pr-2.5 pl-3 text-left text-text-muted transition-colors hover:bg-text/15",
        className,
      )}
      {...props}
    >
      <SearchIcon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="flex-1 font-sans text-label/label">Search</span>
      <span aria-hidden className="font-mono text-caption/4 opacity-70">
        {keycaps}
      </span>
    </button>
  );
}

/**
 * The "Room · N" pill, shown only while a watch room is active; `count` is how many are in the
 * room. It renders a button; pass the router's link through `render` when it navigates. `compact`
 * is the phone bar's form, an icon and the count, beside the avatar; give it an `aria-label`, as
 * the icon alone names nothing.
 */
export function RoomPill({
  count,
  compact = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  readonly count: number;
  readonly compact?: boolean;
}) {
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        type: render === undefined ? "button" : undefined,
        className: cn(
          "flex h-7 shrink-0 cursor-pointer items-center rounded-pill border border-accent font-sans transition-colors hover:bg-accent/15",
          compact ? "gap-1.5 px-2" : "gap-2 px-2.5",
          className,
        ),
        children: compact ? (
          <>
            <UsersIcon aria-hidden className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} />
            <span className="text-caption/4 font-semibold text-text tabular-nums">{count}</span>
          </>
        ) : (
          <>
            <span aria-hidden className="size-1.75 shrink-0 rounded-pill bg-accent" />
            <span className="text-caption/4 font-semibold whitespace-nowrap text-text">
              Room · {count}
            </span>
          </>
        ),
      },
      props,
    ),
  });
}
