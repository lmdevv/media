import { cn } from "@media/ui/lib/utils";

/**
 * The loading ring: a faint full circle with a red quarter arc that turns. With reduced motion it
 * holds still.
 *
 * @param label - Accessible status text, such as `Loading`. Without it the spinner is decorative.
 */
export function Spinner({
  className,
  label,
}: {
  readonly className?: string;
  readonly label?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      data-slot="spinner"
      {...(label === undefined ? { "aria-hidden": true } : { role: "status", "aria-label": label })}
      className={cn("size-4 shrink-0 motion-safe:animate-spin", className)}
    >
      <circle cx="12" cy="12" r="10" className="stroke-current opacity-15" strokeWidth="2" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        className="stroke-accent"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
