import { useCallback, useEffect, useRef, useState } from "react";
import type { Ref } from "react";

/**
 * The focus and shortcut rules every web app follows:
 *
 * 1. Shortcuts are global. They yield only to text fields, to open menus and dialogs, and to the
 *    keys a focused control uses itself (Space on a checkbox, arrows on a slider, Enter anywhere).
 * 2. A pointer click leaves nothing focused, except on text fields, sliders, and radio buttons.
 * 3. An overlay returns focus to its opener on close only when it was opened from the keyboard.
 *
 * Focus rings stay: `:focus-visible` shows them after keyboard use.
 */

/** How a person last pressed something: a key, or a mouse, finger, or pen. */
type InputModality = "keyboard" | "pointer";

/** What the focused element is, as far as the keys and clicks it keeps go. */
export type ControlKind = "none" | "text" | "slider" | "toggle" | "radio" | "control";

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * The keys each kind of focused control uses itself, which shortcuts leave to it. Enter activates
 * whatever control has focus; a text field takes every key.
 */
const KEYS_KEPT: Readonly<Record<ControlKind, ReadonlySet<string> | "every">> = {
  none: new Set(),
  text: "every",
  slider: new Set(["Enter", ...ARROWS, "Home", "End", "PageUp", "PageDown"]),
  toggle: new Set(["Enter", " "]),
  radio: new Set(["Enter", " ", ...ARROWS]),
  control: new Set(["Enter"]),
};

/** Input types that are buttons in all but name: a click on them is a press, not a place to type. */
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image", "file", "color"]);

const TOGGLE_ROLES = new Set(["checkbox", "switch", "menuitemcheckbox"]);

const RADIO_ROLES = new Set(["radio", "menuitemradio"]);

const TEXT_ROLES = new Set(["textbox", "searchbox"]);

/** The attribute that marks a full-screen view built on a dialog, such as Now Playing. */
const KEEPS_SHORTCUTS_ATTRIBUTE = "data-keeps-shortcuts";

/**
 * Spread on a dialog popup that is a full-screen view rather than a dialog, so the app's shortcuts
 * keep working while it is open.
 */
export const keepsShortcutsProps = { [KEEPS_SHORTCUTS_ATTRIBUTE]: "" } as const;

const OPEN_OVERLAY = `:is([role="dialog"], [role="alertdialog"], [role="menu"], dialog[open]):not([data-closed], [hidden], [${KEEPS_SHORTCUTS_ATTRIBUTE}])`;

/**
 * Whether a shortcut on `key` must let the key press through.
 *
 * @param focused - The kind of element with focus; `none` when it is the page itself.
 * @param overlayOpen - Whether a menu or dialog is open.
 */
export function shortcutYields(key: string, focused: ControlKind, overlayOpen: boolean): boolean {
  const kept = KEYS_KEPT[focused];

  return overlayOpen || kept === "every" || kept.has(key);
}

/** Whether a control keeps the focus a pointer click gives it: typing and arrow keys need it. */
export function keepsFocusOnClick(kind: ControlKind): boolean {
  return kind === "text" || kind === "slider" || kind === "radio";
}

const inputKind = (input: HTMLInputElement): ControlKind => {
  if (input.type === "range") return "slider";

  if (input.type === "checkbox") return "toggle";

  if (input.type === "radio") return "radio";

  return BUTTON_INPUT_TYPES.has(input.type) ? "control" : "text";
};

/** Read what kind of control an element is. The page itself (`body`) and non-elements are `none`. */
function controlKindOf(target: EventTarget | null): ControlKind {
  if (!(target instanceof HTMLElement) || target === target.ownerDocument.body) return "none";

  if (target instanceof HTMLInputElement) return inputKind(target);

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return "text";

  if (target.isContentEditable) return "text";

  const role = target.getAttribute("role") ?? "";

  if (role === "slider") return "slider";

  if (TOGGLE_ROLES.has(role)) return "toggle";

  if (RADIO_ROLES.has(role)) return "radio";

  return TEXT_ROLES.has(role) ? "text" : "control";
}

/** Whether a menu or dialog is open, other than a full-screen view marked {@link keepsShortcutsProps}. */
export function isOverlayOpen(): boolean {
  return document.querySelector(OPEN_OVERLAY) !== null;
}

/**
 * Whether a key press belongs to a text field, an open menu or dialog, or the focused control
 * rather than to a global shortcut. A shortcut handler that acts on the press prevents its default,
 * so Space on a focused button plays instead of pressing the button again.
 */
export function keyPressYields(event: KeyboardEvent): boolean {
  return shortcutYields(event.key, controlKindOf(event.target), isOverlayOpen());
}

let lastModality: InputModality = "pointer";

const markKeyboard = (): void => {
  lastModality = "keyboard";
};

const markPointer = (): void => {
  lastModality = "pointer";
};

/** After a pointer click on a button or link, take focus off it so later keys go to shortcuts. */
const blurAfterPointerClick = (event: MouseEvent): void => {
  if (event.detail === 0 || !(event.target instanceof Node)) return;

  const active = event.target.ownerDocument?.activeElement;

  if (!(active instanceof HTMLElement) || !active.contains(event.target)) return;

  if (!keepsFocusOnClick(controlKindOf(active))) active.blur();
};

/**
 * Install rule 2 and the input tracking rule 3 reads: a pointer click leaves nothing focused, and
 * every key and pointer press is recorded for {@link useKeyboardFocusReturn}. Call it once, from
 * the app's root component.
 */
export function useFocusPolicy(): void {
  useEffect(() => {
    document.addEventListener("keydown", markKeyboard, true);
    document.addEventListener("pointerdown", markPointer, true);
    document.addEventListener("click", blurAfterPointerClick);

    return () => {
      document.removeEventListener("keydown", markKeyboard, true);
      document.removeEventListener("pointerdown", markPointer, true);
      document.removeEventListener("click", blurAfterPointerClick);
    };
  }, []);
}

const assignRef = <T>(ref: Ref<T> | undefined, value: T | null): void => {
  if (ref === null || ref === undefined) return;

  if ("current" in ref) ref.current = value;
  else ref(value);
};

/**
 * Rule 3 for an overlay popup: spread the result on the popup. It records how the overlay opened
 * when the popup mounts. After a keyboard open, `finalFocus` is `afterKeyboard`, which by default
 * gives the opener focus back. After a mouse, touch, or pen open it is `false`, so focus goes
 * nowhere, however the overlay closes.
 *
 * @param forwarded - A ref the popup's caller passed, kept working alongside the hook's own.
 * @param afterKeyboard - Where focus goes on close after a keyboard open, as the popup's
 *   `finalFocus` takes it.
 */
export function useKeyboardFocusReturn<T extends HTMLElement, F = true>(
  forwarded?: Ref<T>,
  afterKeyboard?: F,
) {
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false);
  const mounted = useRef<T | null>(null);

  const ref = useCallback(
    (element: T | null) => {
      if (element !== null && element !== mounted.current) {
        mounted.current = element;
        setOpenedByKeyboard(lastModality === "keyboard");
      }

      assignRef(forwarded, element);
    },
    [forwarded],
  );

  return { ref, finalFocus: openedByKeyboard ? (afterKeyboard ?? true) : false };
}
