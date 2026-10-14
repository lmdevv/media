/** What a key pressed in the menu's search field does to the list. */
type MenuKey = "next" | "previous" | "run";

/**
 * Maps a key press in the search field to a list move or to running the selected row, or null for
 * keys the field should handle as typing. Enter while an IME composes text is typing, not "run".
 */
export const menuKeyOf = (
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing">,
): MenuKey | null => {
  // Ctrl+J and Ctrl+P move like the arrows, as in fzf and Emacs. Not Ctrl+N: browsers keep it for
  // a new window and never pass it to the page. Not Ctrl+K: it opens and closes the menu.
  const ctrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;

  if (event.key === "ArrowDown" || (ctrl && event.key === "j")) return "next";

  if (event.key === "ArrowUp" || (ctrl && event.key === "p")) return "previous";

  if (event.key === "Enter" && !event.isComposing) return "run";

  return null;
};
