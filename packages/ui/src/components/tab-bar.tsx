import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@media/ui/lib/utils";
import { SearchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

const glassClassName =
  "on-media rounded-pill border border-text/10 bg-glass shadow-glass backdrop-blur-xl backdrop-saturate-180";

/**
 * The floating phone navigation: a glass capsule of tabs and a separate glass search circle.
 * `minimized` (after scrolling) shrinks the capsule to the current tab's icon.
 *
 * @param search - The search circle, usually a {@link TabBarSearch}.
 */
export function TabBar({
  children,
  search,
  minimized = false,
  className,
}: {
  readonly children: ReactNode;
  readonly search?: ReactNode;
  readonly minimized?: boolean;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="tab-bar"
      data-minimized={minimized || undefined}
      className={cn("group/tab-bar flex items-center justify-between gap-3", className)}
    >
      <nav
        aria-label="Sections"
        className={cn(
          glassClassName,
          "flex h-15.5 items-center p-1 transition-[width] duration-200",
          minimized ? "w-15.5 justify-center" : "flex-1 justify-between",
        )}
      >
        {children}
      </nav>
      {search}
    </div>
  );
}

/**
 * One tab of the {@link TabBar}: icon over a small label. The current tab is red on a lighter pill;
 * in a minimized bar only the current tab shows, as its icon alone. Pass the router's link through
 * `render`.
 */
export function TabBarItem({
  icon,
  label,
  active = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & {
  readonly icon: ReactNode;
  readonly label: string;
  readonly active?: boolean;
}) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        "aria-current": active ? "page" : undefined,
        "aria-label": label,
        className: cn(
          "flex h-13.5 w-17 shrink-0 flex-col items-center justify-center gap-0.75 rounded-pill font-sans [&_svg]:size-5.5",
          active ? "bg-text/16 text-accent inset-shadow-2xs inset-shadow-text/18" : "text-text",
          !active && "group-data-minimized/tab-bar:hidden",
          "group-data-minimized/tab-bar:size-auto group-data-minimized/tab-bar:bg-transparent group-data-minimized/tab-bar:inset-shadow-none group-data-minimized/tab-bar:[&_svg]:size-6",
          className,
        ),
        children: (
          <>
            {icon}
            <span
              aria-hidden
              className={cn(
                "text-tab/3 group-data-minimized/tab-bar:hidden",
                active ? "font-semibold" : "font-medium",
              )}
            >
              {label}
            </span>
          </>
        ),
      },
      props,
    ),
  });
}

/** The separate glass search circle beside the {@link TabBar}; it opens search. */
export function TabBarSearch({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      aria-label="Search"
      aria-haspopup="dialog"
      className={cn(
        glassClassName,
        "flex size-15.5 shrink-0 cursor-pointer items-center justify-center",
        className,
      )}
      {...props}
    >
      <SearchIcon className="size-5.5" strokeWidth={2} aria-hidden />
    </button>
  );
}
