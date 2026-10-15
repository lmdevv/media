import { createCn } from "cn/config";

const BORDER_WIDTHS = ["hairline", "field"];

/** tailwind-merge's border-width groups (`border-w`, `border-w-t`, …) with the token widths. */
const borderWidthGroups = Object.fromEntries(
  ["", "x", "y", "t", "r", "b", "l"].map((side) => [
    side === "" ? "border-w" : `border-w-${side}`,
    [{ [side === "" ? "border" : `border-${side}`]: BORDER_WIDTHS }],
  ]),
);

/**
 * Joins class names and resolves Tailwind conflicts. It knows the token names in
 * `styles/globals.css`, so `text-md` merges as a font size (not a colour), `border-hairline` as a
 * border width, and `rounded-sheet` as a radius.
 */
export const cn = createCn({
  extend: {
    theme: {
      text: [
        "md",
        "display",
        "phone-subhead",
        "phone-body",
        "phone-title",
        "phone-card",
        "phone-large-title",
      ],
      leading: ["xs", "sm", "base", "md", "lg", "xl", "2xl", "display"],
      tracking: ["display", "mono", "snug"],
      "font-weight": ["regular", "heavy"],
      radius: ["phone-art", "phone-card", "sheet"],
      shadow: [
        "dialog",
        "popover",
        "menu",
        "toast",
        "segment",
        "cover",
        "cover-phone",
        "glass",
        "command",
        "art-preview",
        "now-playing-art",
        "now-playing-art-sm",
        "now-playing-art-phone",
        "now-playing-thumb",
        "drop-before",
        "drop-after",
      ],
      spacing: [
        "row",
        "row-touch",
        "safe-top",
        "safe-top-sm",
        "safe-bottom",
        "safe-bottom-lg",
        "dvh-inset",
        "dvh-inset-sm",
        "dvh-sheet",
        "dvh-message",
        "dvh-device-list",
        "now-playing-cover",
        "now-playing-art",
      ],
      container: ["sidebar", "dialog", "content", "vw-inset"],
      blur: ["scrim"],
    },
    classGroups: {
      ...borderWidthGroups,
    },
  },
});
