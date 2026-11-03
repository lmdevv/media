const isMac = /mac|iphone|ipad/i.test(navigator.userAgent);

/** The platform's command key as shown in shortcuts: `⌘` on Apple devices, `Ctrl` elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl ";

/** The platform's Alt key as shown in shortcuts: `⌥` on Apple devices, `Alt` elsewhere. */
export const ALT = isMac ? "⌥" : "Alt ";

/** Whether the platform's command key is held for a keyboard event. */
export const hasMod = (event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean =>
  isMac ? event.metaKey : event.ctrlKey;

/** Whether the event comes from a place where typing text, so single-key shortcuts must not fire. */
export const isTyping = (event: KeyboardEvent): boolean => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
};
