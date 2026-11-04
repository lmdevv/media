import { useRender } from "@base-ui/react/use-render";
import { focusRowItem, rowItems } from "@media/ui/lib/row-focus";
import { cn } from "@media/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useId } from "react";
import type { KeyboardEvent, ReactNode } from "react";

const onTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
  const items = rowItems(event.currentTarget);
  const index = items.findIndex((item) => item === document.activeElement);

  if (index === -1) return;

  const target = (() => {
    switch (event.key) {
      case "ArrowRight":
        return items[index + 1];
      case "ArrowLeft":
        return items[index - 1];
      case "Home":
        return items[0];
      case "End":
        return items.at(-1);
      default:
        return undefined;
    }
  })();

  if (target === undefined) return;

  event.preventDefault();
  focusRowItem(target);
};

function SeeAll(props: useRender.ComponentProps<"a">) {
  const { render, ...rest } = props;

  return useRender({ defaultTagName: "a", render, props: rest });
}

/**
 * A labeled, horizontally scrolling row of cards, such as Continue watching. The track bleeds off
 * the right edge and snaps to cards; ←/→ move between cards and `j`/`k` (see `moveRowFocus`) move
 * between rows.
 *
 * In containers narrower than 48rem it uses the phone layout: a chevron after the title instead of
 * "See all", and tighter insets. It sizes by its container, not the viewport.
 *
 * @param seeAll - The link behind "See all" (desktop) and the chevron (phone), such as the router's
 *   `<Link to="/movies" />`. Its children are supplied.
 */
export function MediaRow({
  title,
  seeAll,
  children,
  className,
}: {
  readonly title: string;
  readonly seeAll?: useRender.RenderProp;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={cn("@container flex w-full flex-col", className)}
    >
      <div className="flex items-center gap-1 px-5 pt-6 pb-2.5 @3xl:box-content @3xl:max-w-content @3xl:items-baseline @3xl:justify-between @3xl:px-16 @3xl:pt-0 @3xl:pb-3.5">
        <h2
          id={headingId}
          className="font-sans text-heading/6 font-bold text-text @3xl:text-heading/heading @3xl:tracking-tight"
        >
          {title}
        </h2>
        {seeAll === undefined ? null : (
          <>
            <SeeAll render={seeAll} className="@3xl:hidden" aria-label={`See all ${title}`}>
              <ChevronRightIcon className="size-4 text-text-muted" strokeWidth={2.25} aria-hidden />
            </SeeAll>
            <SeeAll
              render={seeAll}
              className="hidden font-sans text-label/label font-medium text-text-muted transition-colors hover:text-text @3xl:inline"
            >
              See all
            </SeeAll>
          </>
        )}
      </div>
      <div
        data-media-row=""
        onKeyDown={onTrackKeyDown}
        className="flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto overscroll-x-contain px-4 py-1 scrollbar-none @3xl:scroll-px-16 @3xl:gap-4 @3xl:px-16"
      >
        {children}
      </div>
    </section>
  );
}
