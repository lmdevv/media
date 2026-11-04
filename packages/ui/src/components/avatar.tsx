import { monogramOf } from "@media/ui/lib/monogram";
import { cn } from "@media/ui/lib/utils";
import { PencilIcon } from "lucide-react";

const SIZES = {
  xs: "size-7",
  sm: "size-8",
  md: "size-24",
  lg: "size-28",
  xl: "size-40",
} as const;

const MONOGRAMS = {
  xs: "p-1 text-caption/4",
  sm: "p-1 text-caption/4",
  md: "p-2.5 text-avatar/9",
  lg: "p-3 text-title/title",
  xl: "p-3.5 text-display/display",
} as const;

/** Avatar dimensions, from the 28px compact bar up to the 160px profile picker. */
export type AvatarSize = keyof typeof SIZES;

/**
 * A profile picture. Without an image, or with `monogram`, it shows the name's first letter in the
 * bottom-left corner the way the profile picker draws it, or in the middle with `centered`.
 *
 * @param image - Picture URL; omit for a plain raised tile.
 * @param round - Draw a circle, as on phones; otherwise a square with 4px corners, as on desktop.
 * @param centered - Put the letter in the middle, as a person's photo placeholder does.
 * @param decorative - Hide the avatar from assistive technology, for when the name is already
 *   written next to it, as in a link that would otherwise read the name twice.
 * @param monogramClassName - Extra classes for the letter, such as hiding it on phones.
 */
export function Avatar({
  name,
  image,
  size = "sm",
  round = false,
  monogram = false,
  centered = false,
  decorative = false,
  className,
  monogramClassName,
}: {
  readonly name: string;
  readonly image?: string | undefined;
  readonly size?: AvatarSize;
  readonly round?: boolean;
  readonly monogram?: boolean;
  readonly centered?: boolean;
  readonly decorative?: boolean;
  readonly className?: string;
  readonly monogramClassName?: string | undefined;
}) {
  const showMonogram = monogram || image === undefined;

  return (
    <span
      data-slot="avatar"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      className={cn(
        "relative flex shrink-0 overflow-hidden bg-surface-raised bg-cover bg-center select-none",
        centered ? "items-center justify-center" : "items-end",
        SIZES[size],
        round ? "rounded-pill" : "rounded-poster",
        className,
      )}
      style={image === undefined ? undefined : { backgroundImage: `url("${image}")` }}
    >
      {showMonogram ? (
        <span
          aria-hidden
          className={cn(
            "font-sans font-heavy tracking-display",
            image === undefined ? "text-text-muted" : "text-dark-text/85",
            MONOGRAMS[size],
            monogramClassName,
          )}
        >
          {monogramOf(name)}
        </span>
      ) : null}
    </span>
  );
}

/** An avatar with the round pencil button that opens avatar editing, as on the profile editor. */
export function EditableAvatar({
  name,
  image,
  onEdit,
  monogram,
  size = "lg",
}: {
  readonly name: string;
  readonly image?: string | undefined;
  readonly onEdit: () => void;
  readonly monogram?: boolean;
  readonly size?: AvatarSize;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={name} size={size} image={image} monogram={monogram ?? false} />
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${name}'s avatar`}
        className="on-media absolute right-2 bottom-2 flex size-8 cursor-pointer items-center justify-center rounded-pill bg-dark-bg/55 backdrop-blur-md transition-colors hover:bg-dark-bg/75"
      >
        <PencilIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
      </button>
    </span>
  );
}
