import { createCn } from "cn/config";

/**
 * Join class names and resolve Tailwind conflicts (the last class wins), knowing the theme
 * scale: without it, custom sizes such as `text-micro` read as colors and get dropped next to
 * `text-danger`.
 */
export const cn = createCn({
  extend: {
    theme: {
      text: [
        "caption",
        "label",
        "body",
        "heading",
        "title",
        "display",
        "tab",
        "micro",
        "wordmark",
        "lead",
        "subtitle",
        "search",
        "large-title",
        "hero-card",
        "hero",
        "small",
        "button",
        "command",
        "logo",
        "avatar",
      ],
      leading: ["caption", "label", "body", "heading", "title", "display"],
      "font-weight": ["regular", "heavy", "hero", "tagline"],
      tracking: ["display", "caps", "snug", "hero", "spread", "eyebrow"],
      radius: ["poster", "control", "card", "pill", "thumb", "bar", "inner", "search"],
      shadow: ["overlay", "glass"],
      container: ["dialog", "content"],
    },
    classGroups: { "border-w": [{ border: ["control", "radio-checked"] }] },
  },
});
