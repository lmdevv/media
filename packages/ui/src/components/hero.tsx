import { cn } from "@media/ui/lib/utils";
import { useCallback, useId, useState } from "react";
import type { ReactNode } from "react";

type HeroContent = {
  readonly title: string;
  /** The title treatment, usually the title's logo image. Defaults to the title as heavy text. */
  readonly titleArt?: ReactNode;
  /** Backdrop image URL; the hero shows the page color with scrims until it loads. */
  readonly backdrop?: string | undefined;
  readonly actions?: ReactNode;
};

/**
 * The full-bleed desktop billboard: backdrop with scrims, title treatment, facts, overview, and the
 * Play and More info buttons. Its chrome stays white over the artwork in both themes, and its
 * bottom edge fades into the page.
 *
 * @param highlight - A short green lead-in to the facts, such as `New this week`.
 * @param facts - Plain facts such as `2024 · 2h 46m · PG-13`.
 * @param badges - Mono badges after the facts, such as `4K HDR`.
 * @param overview - The synopsis, held to three lines; when it runs longer, "Read more" opens the
 *   rest in a short scrolling box.
 * @param topBar - The `TopBar` drawn over the top of the backdrop.
 */
export function Hero({
  title,
  titleArt,
  backdrop,
  highlight,
  facts,
  badges,
  overview,
  actions,
  topBar,
  className,
}: HeroContent & {
  readonly highlight?: string | undefined;
  readonly facts?: string | undefined;
  readonly badges?: ReactNode;
  readonly overview?: string | undefined;
  readonly topBar?: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      aria-label={title}
      data-slot="hero"
      className={cn(
        "on-media relative isolate flex min-h-190 w-full flex-col justify-between overflow-hidden bg-dark-surface bg-cover bg-center px-16 pb-30",
        className,
      )}
      style={backdrop === undefined ? undefined : { backgroundImage: `url("${backdrop}")` }}
    >
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-linear-to-r from-dark-bg/75 to-transparent to-55%"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-linear-to-b from-dark-bg/55 via-transparent via-22% to-transparent"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-linear-to-b from-transparent from-60% to-page to-97%"
      />
      <div className="mx-auto w-full max-w-content">{topBar}</div>
      <div className="mx-auto flex w-full max-w-content flex-col">
        <div className="flex w-140 flex-col gap-5">
          {titleArt ?? (
            <h1 className="font-sans text-display/display font-heavy tracking-display">{title}</h1>
          )}
          {highlight === undefined && facts === undefined && badges === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2.5 pt-1 font-sans text-body/body">
              {highlight === undefined ? null : (
                <span className="font-semibold text-success">{highlight}</span>
              )}
              {facts === undefined ? null : <span>{facts}</span>}
              {badges}
            </div>
          )}
          {overview === undefined ? null : <HeroOverview key={overview} text={overview} />}
          {actions === undefined ? null : (
            <div className="flex items-center gap-3 pt-2">{actions}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function HeroOverview({ text }: { readonly text: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  const watchClamp = useCallback((element: HTMLParagraphElement | null) => {
    if (element === null) return undefined;

    const check = (): void => setClamped(element.scrollHeight > element.clientHeight);
    const observer = new ResizeObserver(check);

    observer.observe(element);
    document.fonts.addEventListener("loadingdone", check);

    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", check);
    };
  }, []);

  return (
    <div className="flex w-125 flex-col items-start gap-1.5">
      <p
        id={id}
        ref={expanded ? undefined : watchClamp}
        role={expanded ? "region" : undefined}
        aria-label={expanded ? "Overview" : undefined}
        tabIndex={expanded ? 0 : undefined}
        className={cn(
          "font-sans text-lead/6.5",
          expanded ? "max-h-45.5 overflow-y-auto overscroll-contain" : "line-clamp-3",
        )}
      >
        {text}
      </p>
      {clamped ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
          className="cursor-pointer rounded-bar font-sans text-body/body font-semibold text-text/75 underline-offset-4 transition-colors hover:text-text hover:underline"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The phone billboard: a rounded card with the backdrop, centered title treatment and genre line,
 * and two pill buttons (such as Resume and My List).
 *
 * @param facts - The line under the title, such as `Sci-fi · Epic · 2024`.
 */
export function HeroCard({
  title,
  titleArt,
  backdrop,
  facts,
  actions,
  className,
}: HeroContent & { readonly facts?: string | undefined; readonly className?: string }) {
  return (
    <section
      aria-label={title}
      data-slot="hero-card"
      className={cn(
        "on-media relative isolate flex h-110 w-full flex-col justify-end gap-3.5 overflow-hidden rounded-card bg-dark-surface-raised bg-cover bg-center p-5",
        className,
      )}
      style={backdrop === undefined ? undefined : { backgroundImage: `url("${backdrop}")` }}
    >
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-linear-to-b from-transparent from-40% to-dark-bg/85"
      />
      <div className="flex flex-col items-center gap-1.5 text-center">
        {titleArt ?? (
          <h1 className="font-sans text-title/title font-heavy tracking-display">{title}</h1>
        )}
        {facts === undefined ? null : (
          <p className="font-sans text-label/4 font-medium text-text/75">{facts}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex gap-2.5 *:flex-1">{actions}</div>}
    </section>
  );
}
