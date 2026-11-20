"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@media/ui/lib/utils";
import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { MENU_ITEM_CLASS, MENU_POPUP_CLASS } from "./dropdown-menu";

/** The keys that open a context menu from the keyboard: the Menu key and Shift+F10. */
const opensMenu = (event: KeyboardEvent): boolean =>
  event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

/**
 * Our menu in place of the browser's on right click, the Menu key, Shift+F10, or a long press,
 * over whatever `children` render. The trigger adds no box (`display: contents`), so the children
 * keep their place in a row or grid. `content` mounts only while the menu is open.
 *
 * Focus returns to the element that had it only when the keyboard opened the menu; after a pointer
 * open, nothing stays focused.
 */
export function ContextMenu({
  content,
  children,
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
}) {
  const menuKey = useRef(false);
  const opener = useRef<HTMLElement | null>(null);

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger
        className="contents"
        onKeyDown={(event) => {
          menuKey.current = opensMenu(event);
        }}
        onContextMenu={() => {
          const active = document.activeElement;

          opener.current = menuKey.current && active instanceof HTMLElement ? active : null;
          menuKey.current = false;
        }}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
          <ContextMenuPrimitive.Popup
            data-slot="context-menu-content"
            className={MENU_POPUP_CLASS}
            finalFocus={() => opener.current ?? false}
          >
            {content}
          </ContextMenuPrimitive.Popup>
        </ContextMenuPrimitive.Positioner>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

/** A context menu action. */
export function ContextMenuItem({ className, ...props }: ContextMenuPrimitive.Item.Props) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(MENU_ITEM_CLASS, className)}
      {...props}
    />
  );
}

/** A context menu row that navigates. Pass the router's link through `render`. */
export function ContextMenuLinkItem({ className, ...props }: ContextMenuPrimitive.LinkItem.Props) {
  return (
    <ContextMenuPrimitive.LinkItem
      data-slot="context-menu-item"
      className={cn(MENU_ITEM_CLASS, className)}
      {...props}
    />
  );
}
