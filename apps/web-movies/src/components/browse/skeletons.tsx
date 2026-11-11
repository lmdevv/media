import { cn } from "@media/ui/lib/utils";

function Block({
  className,
  tone = "card",
}: {
  readonly className: string;
  readonly tone?: "bar" | "card";
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "shrink-0 motion-safe:animate-pulse",
        tone === "bar" ? "bg-text/6" : "bg-text/5",
        className,
      )}
    />
  );
}

/**
 * The billboard placeholder. `inset` draws Paper's scanning layout: a rounded box inside the page
 * margins; otherwise it fills the hero's full-bleed space.
 */
export function HeroSkeleton({ inset = false }: { readonly inset?: boolean }) {
  const bars = (
    <>
      <Block tone="bar" className="h-14 w-60 rounded-inner md:w-90" />
      <Block tone="bar" className="h-3.5 w-40 rounded-poster md:w-60" />
      <div className="flex gap-3 pt-1">
        <Block tone="bar" className="h-11 w-27.5 rounded-control" />
        <Block tone="bar" className="h-11 w-35 rounded-control" />
      </div>
    </>
  );

  if (inset) {
    return (
      <div aria-hidden className="px-4 md:px-16">
        <div className="mx-auto flex h-110 w-full max-w-content flex-col justify-end gap-3.5 rounded-card bg-surface-raised p-5 md:h-90 md:rounded-control md:p-10">
          {bars}
        </div>
      </div>
    );
  }

  return (
    <div
      aria-hidden
      className="mx-4 flex h-110 flex-col justify-end rounded-card bg-surface-raised p-5 md:mx-0 md:h-190 md:rounded-none md:px-16 md:pb-30"
    >
      <div className="flex w-full flex-col gap-3.5 md:mx-auto md:max-w-content">{bars}</div>
    </div>
  );
}

/** A row of blank cards under a blank heading. */
export function RowSkeleton({
  kind,
  heading = true,
}: {
  readonly kind: "poster" | "landscape";
  readonly heading?: boolean;
}) {
  return (
    <div aria-hidden className="flex flex-col gap-3.5 overflow-hidden px-4 md:px-16">
      {heading ? <Block tone="bar" className="h-5 w-55 rounded-poster bg-surface-raised" /> : null}
      <div className="flex gap-2.5 md:gap-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Block
            key={index}
            className={cn(
              "rounded-poster",
              kind === "poster" ? "aspect-2/3 w-42" : "aspect-video w-50 md:w-72",
            )}
          />
        ))}
      </div>
    </div>
  );
}

/** A grid of blank posters with their two text lines, for the Movies, Shows and My List grids. */
export function PosterGridSkeleton({ count = 14 }: { readonly count?: number }) {
  return (
    <div
      aria-hidden
      className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-[repeat(auto-fill,minmax(var(--spacing-42),1fr))] md:gap-x-5.5 md:gap-y-8"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Block className="aspect-2/3 w-full rounded-poster" />
          <Block tone="bar" className="mt-1 h-3.5 w-3/4 rounded-bar" />
          <Block tone="bar" className="h-3 w-1/2 rounded-bar" />
        </div>
      ))}
    </div>
  );
}
