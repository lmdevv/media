import { useSyncExternalStore } from "react";

/**
 * Tailwind's `md` breakpoint, where dark pages move from `dark-bg` to `dark-surface` (see the
 * `.dark` rules in the UI kit's globals.css).
 */
const DESKTOP = "(width >= 48rem)";

const readPageColor = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--color-page").trim();

const pageColor = (() => {
  let color = "";

  return {
    subscribe: (onChange: () => void): (() => void) => {
      const update = (): void => {
        color = readPageColor();
        onChange();
      };

      const observer = new MutationObserver(update);
      const desktop = window.matchMedia(DESKTOP);

      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      desktop.addEventListener("change", update);
      color = readPageColor();

      return () => {
        observer.disconnect();
        desktop.removeEventListener("change", update);
      };
    },
    read: (): string => color,
  };
})();

/**
 * The browser's theme color (a phone's status bar, an installed app's title bar), kept on the page
 * color of whichever theme is showing: the saved choice, or the system's when it follows the system.
 */
export function ThemeColor() {
  const color = useSyncExternalStore(pageColor.subscribe, pageColor.read);

  return color === "" ? null : <meta name="theme-color" content={color} />;
}
