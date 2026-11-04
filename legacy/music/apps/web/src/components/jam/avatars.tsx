import type { Contributor } from "@music/commands/models";
import { cn } from "@music/ui/lib/utils";

import { initial } from "@/lib/format";

/** One person's initial in a circle, the way a Jam shows who is in it and who added what. */
export function Avatar({
  person,
  className,
}: {
  readonly person: Contributor;
  readonly className?: string;
}) {
  return (
    <span
      title={person.name}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-text font-sans text-xs/xs font-semibold text-text-inverse ring-2 ring-bg",
        className,
      )}
    >
      {initial(person.name)}
    </span>
  );
}

/** Up to `max` overlapping avatars, then "+N". */
export function AvatarStack({
  people,
  max = 4,
  className,
}: {
  readonly people: ReadonlyArray<Contributor>;
  readonly max?: number;
  readonly className?: string;
}) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;

  return (
    <span aria-hidden className={cn("flex items-center -space-x-1.5", className)}>
      {shown.map((person) => (
        <Avatar key={person.id} person={person} />
      ))}
      {more > 0 ? (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface font-sans text-xs/xs font-semibold text-text ring-2 ring-bg">
          +{more}
        </span>
      ) : null}
    </span>
  );
}
