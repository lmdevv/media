import { cn } from "@media/ui/lib/utils";
import type { ReactNode } from "react";

const BOX = 72;

const RADIUS = 30;

const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A circular progress ring: a faint full circle and an arc from the top, clockwise. Paper draws it
 * for buffering (72px, with the percentage below), a guest catching up to the room, and a host's
 * connection (56px, white arc). `spinning` turns it for waits without a measure.
 *
 * @param value - Fraction done, from 0 to 1.
 * @param tone - `accent` draws the arc in Netflix red; `text` in white over media.
 * @param children - Content in the middle, such as a countdown digit.
 */
export function ProgressRing({
  value,
  tone = "accent",
  spinning = false,
  thickness = 4,
  label,
  className,
  children,
}: {
  readonly value: number;
  readonly tone?: "accent" | "text";
  readonly spinning?: boolean;
  /** Stroke width in the ring's 72-unit box: 4 for the large rings, 7 for the 32px countdown. */
  readonly thickness?: number;
  /** Accessible status text; without it the ring is decorative. */
  readonly label?: string | undefined;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const fraction = Math.min(1, Math.max(0, value));

  return (
    <span
      data-slot="progress-ring"
      {...(label === undefined
        ? { "aria-hidden": true }
        : {
            role: "progressbar",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.round(fraction * 100),
          })}
      className={cn("relative inline-flex size-18 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox={`0 0 ${String(BOX)} ${String(BOX)}`}
        fill="none"
        className={cn("absolute inset-0 size-full", spinning && "motion-safe:animate-spin")}
      >
        <circle
          cx={BOX / 2}
          cy={BOX / 2}
          r={RADIUS}
          className="stroke-current opacity-18"
          strokeWidth={thickness}
        />
        <circle
          cx={BOX / 2}
          cy={BOX / 2}
          r={RADIUS}
          transform={`rotate(-90 ${String(BOX / 2)} ${String(BOX / 2)})`}
          className={tone === "accent" ? "stroke-accent" : "stroke-current"}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        />
      </svg>
      {children}
    </span>
  );
}
