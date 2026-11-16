import { cn } from "@/lib/utils";

import { initial } from "@/lib/format";

/** One person's initial in a circle, the way a Jam shows who is in it. */
export function Avatar({
  name,
  className,
}: {
  readonly name: string;
  readonly className?: string;
}) {
  return (
    <span
      title={name}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-text font-sans text-xs/xs font-semibold text-text-inverse ring-2 ring-bg",
        className,
      )}
    >
      {initial(name)}
    </span>
  );
}

/** Up to `max` overlapping avatars, then "+N". */
export function AvatarStack({
  names,
  max = 4,
  className,
}: {
  readonly names: ReadonlyArray<string>;
  readonly max?: number;
  readonly className?: string;
}) {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;

  return (
    <span aria-hidden className={cn("flex items-center -space-x-1.5", className)}>
      {shown.map((name, index) => (
        <Avatar key={`${name}-${String(index)}`} name={name} />
      ))}
      {more > 0 ? (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface font-sans text-xs/xs font-semibold text-text ring-2 ring-bg">
          +{more}
        </span>
      ) : null}
    </span>
  );
}
