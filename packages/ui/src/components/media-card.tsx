import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@media/ui/lib/utils";
import { useState } from "react";
import type { ReactNode } from "react";

import { Badge } from "./badge";
import { ProgressBar } from "./progress-bar";

type CardProps = useRender.ComponentProps<"a"> & {
  readonly title: string;
  /** Artwork URL. The card shows a raised placeholder until it loads or when it is missing. */
  readonly image?: string | undefined;
  /** Red flag in the artwork's top-right corner, such as `NEW` or `NEW EPISODE`. */
  readonly badge?: string | undefined;
};

function Artwork({
  image,
  className,
  children,
}: {
  readonly image: string | undefined;
  readonly className: string;
  readonly children?: ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = image !== undefined && failed !== image;

  return (
    <span
      className={cn(
        "relative isolate flex w-full shrink-0 overflow-hidden bg-surface-raised transition-[filter] group-hover/card:brightness-110",
        className,
      )}
    >
      {shown ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(image)}
          className="absolute inset-0 -z-10 size-full object-cover"
        />
      ) : null}
      {children}
    </span>
  );
}

/**
 * A 16:9 card for rows of things to resume or recommendations: artwork with an optional watched
 * bar, then the title and a muted line. Pass the router's link through `render`.
 *
 * @param progress - Fraction watched, from 0 to 1; omit to hide the bar.
 * @param size - `desktop` is 288px wide; `phone` is 200px with softer corners.
 * @param action - A second control in the artwork's bottom-right corner, such as an info link. It
 *   sits beside the card's link, not inside it, and shows on hover, on keyboard focus, and always on
 *   touch screens.
 */
export function LandscapeCard({
  title,
  subtitle,
  image,
  badge,
  progress,
  size = "desktop",
  action,
  className,
  render,
  ...props
}: CardProps & {
  readonly subtitle?: string | undefined;
  readonly progress?: number | undefined;
  readonly size?: "desktop" | "phone";
  readonly action?: ReactNode;
}) {
  const percent = progress === undefined ? undefined : Math.round(progress * 100);

  const frame = cn(
    "group/card shrink-0 snap-start",
    size === "desktop" ? "w-72" : "w-50",
    className,
  );

  const link = useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        className: cn(
          "flex flex-col rounded-poster",
          size === "desktop" ? "gap-2" : "gap-1.5",
          action === undefined && frame,
        ),
        children: (
          <>
            <Artwork
              image={image}
              className={cn(
                "aspect-video flex-col justify-between",
                size === "desktop" ? "rounded-poster" : "rounded-thumb",
              )}
            >
              {badge === undefined ? (
                <span />
              ) : (
                <Badge variant="accent" className="m-2 self-end">
                  {badge}
                </Badge>
              )}
              {progress === undefined ? null : <ProgressBar value={progress} />}
            </Artwork>
            <span className="font-sans text-label/4 font-semibold text-text">{title}</span>
            {subtitle === undefined ? null : (
              <span className="font-sans text-caption/4 text-text-muted">{subtitle}</span>
            )}
            {percent === undefined ? null : <span className="sr-only">{percent}% watched</span>}
          </>
        ),
      },
      props,
    ),
  });

  if (action === undefined) return link;

  return (
    <div className={cn("relative", frame)}>
      {link}
      <span className="pointer-events-none absolute inset-x-0 top-0 flex aspect-video items-end justify-end p-2 opacity-0 transition-opacity group-hover/card:opacity-100 group-has-focus-visible/card:opacity-100 pointer-coarse:opacity-100 *:pointer-events-auto">
        {action}
      </span>
    </div>
  );
}

/**
 * A 2:3 poster card for browsing rows and grids: artwork with an optional red flag, then the title
 * and, in grids, a muted line such as `2024 · 2h 46m`.
 */
export function PosterCard({
  title,
  subtitle,
  image,
  badge,
  className,
  render,
  ...props
}: CardProps & { readonly subtitle?: string | undefined }) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        className: cn(
          "group/card flex w-42 shrink-0 snap-start flex-col rounded-poster",
          subtitle === undefined ? "gap-2" : "gap-1.5",
          className,
        ),
        children: (
          <>
            <Artwork
              image={image}
              className="aspect-2/3 items-start justify-end rounded-poster p-2.5"
            >
              {badge === undefined ? null : <Badge variant="accent">{badge}</Badge>}
            </Artwork>
            <span
              className={cn(
                "font-sans text-label/4 font-semibold text-text",
                subtitle !== undefined && "pt-1",
              )}
            >
              {title}
            </span>
            {subtitle === undefined ? null : (
              <span className="font-sans text-caption/4 text-text-muted">{subtitle}</span>
            )}
          </>
        ),
      },
      props,
    ),
  });
}

/**
 * An episode in a season list: number, still with watched bar, title and runtime, synopsis, and a
 * mono line of technical facts. Pass the router's link or a button through `render`.
 *
 * @param facts - Mono details such as `HEVC · DIRECT · 41m left`.
 * @param credits - Who is in or made the episode, such as `Guest stars Ada Stream, Gus Guest`.
 */
export function EpisodeRow({
  number,
  title,
  runtime,
  synopsis,
  credits,
  facts,
  image,
  progress,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & {
  readonly number: number;
  readonly title: string;
  readonly runtime?: string | undefined;
  readonly synopsis?: string | undefined;
  readonly credits?: string | undefined;
  readonly facts?: string | undefined;
  readonly image?: string | undefined;
  readonly progress?: number | undefined;
}) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        className: cn(
          "group/card flex w-full max-w-190 items-center gap-5 rounded-control bg-surface-raised p-4 text-left transition-colors hover:bg-text/10",
          className,
        ),
        children: (
          <>
            <span className="w-7 shrink-0 text-center font-sans text-heading/6 font-semibold text-text-muted">
              {number}
            </span>
            <Artwork image={image} className="aspect-video w-44 items-end rounded-poster">
              {progress === undefined ? null : <ProgressBar value={progress} />}
            </Artwork>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="flex items-baseline justify-between gap-4">
                <span className="font-sans text-body/4.5 font-semibold text-text">{title}</span>
                {runtime === undefined ? null : (
                  <span className="shrink-0 font-sans text-label/4 text-text-muted">{runtime}</span>
                )}
              </span>
              {synopsis === undefined ? null : (
                <span className="line-clamp-2 font-sans text-label/label text-text-muted">
                  {synopsis}
                </span>
              )}
              {credits === undefined ? null : (
                <span className="truncate font-sans text-label/label text-text-muted">
                  {credits}
                </span>
              )}
              {facts === undefined ? null : (
                <span className="font-mono text-caption/4 text-text-muted">{facts}</span>
              )}
            </span>
          </>
        ),
      },
      props,
    ),
  });
}
