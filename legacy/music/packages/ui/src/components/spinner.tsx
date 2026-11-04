import { cn } from "@music/ui/lib/utils";

/** The Paper ring spinner: a hairline circle with a quarter arc that turns. */
export function Spinner({
  className,
  label = "Loading",
}: {
  readonly className?: string;
  readonly label?: string;
}) {
  return (
    <svg
      viewBox="0 0 40 40"
      role="img"
      aria-label={label}
      className={cn("size-4 shrink-0 animate-spin", className)}
    >
      <circle cx="20" cy="20" r="16" fill="none" stroke="var(--color-border)" strokeWidth="4" />
      <path
        d="M20 4a16 16 0 0 1 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
