import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@music/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import type { ComponentProps } from "react";

/** A menu of actions, such as the track row menu. */
export const DropdownMenu = MenuPrimitive.Root;

/** The element that opens a {@link DropdownMenu}. Use `render` to supply your own button. */
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

/** A nested menu, such as "Add to playlist". */
export const DropdownMenuSub = MenuPrimitive.SubmenuRoot;

const popupClassName =
  "flex max-h-(--available-height) min-w-62 origin-(--transform-origin) flex-col overflow-y-auto rounded-md border border-border bg-surface-raised p-1.5 text-text shadow-menu outline-none data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95";

/** The Paper menu panel: 8px radius, hairline border, 6px padding. */
export function DropdownMenuContent({
  className,
  align = "end",
  side = "bottom",
  sideOffset = 4,
  alignOffset = 0,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "side" | "sideOffset" | "alignOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        side={side}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
      >
        <MenuPrimitive.Popup className={cn(popupClassName, className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

const itemClassName =
  "flex h-8.5 shrink-0 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 font-sans text-base/sm text-text outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-(--opacity-disabled) data-highlighted:bg-surface [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** One action in a menu. `shortcut` shows its key on the right, in mono. */
export function DropdownMenuItem({
  className,
  children,
  shortcut,
  tone = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  readonly shortcut?: string;
  readonly tone?: "default" | "danger";
}) {
  return (
    <MenuPrimitive.Item
      className={cn(itemClassName, tone === "danger" && "text-danger", className)}
      {...props}
    >
      {children}
      {shortcut === undefined ? null : (
        <span className="ml-auto font-mono text-xs/xs text-text-muted">{shortcut}</span>
      )}
    </MenuPrimitive.Item>
  );
}

/** The row that opens a {@link DropdownMenuSub}. */
export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(itemClassName, "data-popup-open:bg-surface", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-3.5" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

/** The panel of a {@link DropdownMenuSub}. */
export function DropdownMenuSubContent({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        side="left"
        sideOffset={8}
        alignOffset={-6}
      >
        <MenuPrimitive.Popup
          className={cn(popupClassName, "min-w-70 gap-0.5", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** A hairline between groups of menu items. */
export function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-1.5 my-1 h-px shrink-0 bg-border", className)}
      {...props}
    />
  );
}

/** A small muted heading inside a menu. */
export function DropdownMenuLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "px-2.5 pt-2 pb-1.5 font-sans text-xs/xs font-semibold text-text-muted",
        className,
      )}
      {...props}
    />
  );
}
