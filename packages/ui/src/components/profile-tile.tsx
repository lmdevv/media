import { cn } from "@media/ui/lib/utils";
import { LockIcon, PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Avatar } from "./avatar";

const tileClassName =
  "group/tile flex w-35 shrink-0 cursor-pointer flex-col items-center gap-2.5 rounded-poster font-sans outline-none md:w-40 md:gap-3.5";

const squareClassName = "size-26 rounded-pill md:size-40 md:rounded-poster";

const ringClassName =
  "transition-shadow group-hover/tile:ring-3 group-hover/tile:ring-accent group-hover/tile:ring-offset-3 group-hover/tile:ring-offset-page group-focus-visible/tile:ring-3 group-focus-visible/tile:ring-accent group-focus-visible/tile:ring-offset-3 group-focus-visible/tile:ring-offset-page";

const nameClassName =
  "text-lead/body font-semibold text-text transition-colors md:text-heading/heading md:font-medium md:text-text-muted md:group-hover/tile:font-semibold md:group-hover/tile:text-text md:group-focus-visible/tile:font-semibold md:group-focus-visible/tile:text-text";

/**
 * A profile on the "Who's watching?" picker: a 160px square avatar and the name, with a lock under
 * profiles that need a PIN. Hover and keyboard focus draw the red ring. Below `md` it is the iOS
 * tile: a 104px circle with the name in full contrast.
 *
 * @param monogram - Draw the name's first letter over the avatar image.
 */
export function ProfileTile({
  name,
  image,
  locked = false,
  monogram = false,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & {
  readonly name: string;
  readonly image?: string | undefined;
  readonly locked?: boolean;
  readonly monogram?: boolean;
}) {
  return (
    <button
      type={type}
      data-slot="profile-tile"
      className={cn(tileClassName, className)}
      {...props}
    >
      <Avatar
        name={name}
        image={image}
        size="xl"
        monogram={monogram}
        monogramClassName={image === undefined ? undefined : "max-md:hidden"}
        className={cn(squareClassName, ringClassName)}
      />
      <span className={nameClassName}>{name}</span>
      <span className="flex h-4 items-center justify-center text-text-muted">
        {locked ? (
          <>
            <LockIcon className="size-4" strokeWidth={1.75} aria-hidden />
            <span className="sr-only">PIN required</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

/** The dashed "Add profile" tile at the end of the picker. */
export function AddProfileTile({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="add-profile-tile"
      className={cn(tileClassName, className)}
      {...props}
    >
      <span
        className={cn(
          "flex items-center justify-center bg-text/8 text-text md:border-control md:border-dashed md:border-hairline md:bg-transparent md:text-text-muted",
          squareClassName,
          ringClassName,
        )}
      >
        <PlusIcon className="size-9 md:size-11" strokeWidth={1.5} aria-hidden />
      </span>
      <span className={cn(nameClassName, "text-text-muted")}>Add profile</span>
      <span className="h-4" />
    </button>
  );
}
