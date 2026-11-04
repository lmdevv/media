/** The thin accent progress bar used for scans. */
export function ProgressBar({
  percent,
  className = "h-1",
  label,
}: {
  readonly percent: number;
  readonly className?: string;
  readonly label: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`flex shrink-0 overflow-hidden rounded-full bg-border ${className}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
