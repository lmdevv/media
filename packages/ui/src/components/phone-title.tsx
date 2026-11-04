import { cn } from "@media/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * The phone page header: a large heavy title with a trailing slot (usually the round avatar). After
 * scrolling it hands over to {@link CompactTopBar}.
 */
export function LargeTitle({
  title,
  trailing,
  className,
}: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      data-slot="large-title"
      className={cn("flex items-end justify-between gap-4 px-5 pt-1 pb-3 font-sans", className)}
    >
      <h1 className="text-large-title/10 font-heavy tracking-snug text-text">{title}</h1>
      {trailing}
    </header>
  );
}

/**
 * The compact glass bar a phone page shows once its {@link LargeTitle} scrolls away: the title
 * centered over frosted glass, the trailing slot (avatar) at the right. It reserves the top safe area.
 *
 * @param visible - Fades the bar in; hidden bars are inert.
 */
export function CompactTopBar({
  title,
  trailing,
  visible,
  className,
}: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly visible: boolean;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="compact-top-bar"
      aria-hidden={!visible}
      inert={!visible}
      className={cn(
        "on-media border-b border-text/6 bg-dark-surface/66 pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-180 transition-opacity duration-200",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
    >
      <div className="relative flex h-11 items-center justify-center px-4">
        <span className="font-sans text-lead/5.5 font-bold tracking-tight">{title}</span>
        {trailing === undefined ? null : <span className="absolute top-2 right-4">{trailing}</span>}
      </div>
    </div>
  );
}
