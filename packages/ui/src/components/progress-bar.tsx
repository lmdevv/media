import { cn } from "@media/ui/lib/utils";

/**
 * A watched or job progress bar: an accent fill over a translucent track.
 *
 * @param value - Fraction done, from 0 to 1; values outside are clamped.
 * @param tone - `media` on artwork (white track), `surface` on panels (track in the text color).
 * @param label - Accessible name, such as `62% watched`. Without it the bar is decorative.
 */
export function ProgressBar({
  value,
  tone = "media",
  thickness = "regular",
  label,
  className,
}: {
  readonly value: number;
  readonly tone?: "media" | "surface";
  readonly thickness?: "regular" | "thin";
  readonly label?: string;
  readonly className?: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);

  return (
    <div
      data-slot="progress-bar"
      {...(label === undefined
        ? { "aria-hidden": true }
        : {
            role: "progressbar",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": percent,
          })}
      className={cn(
        "flex w-full shrink-0 overflow-hidden",
        thickness === "regular" ? "h-1" : "h-0.5 rounded-bar",
        tone === "media" ? "bg-dark-text/25" : "bg-text/10",
        className,
      )}
    >
      <div
        className={cn("h-full bg-accent", thickness === "thin" && "rounded-bar")}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
