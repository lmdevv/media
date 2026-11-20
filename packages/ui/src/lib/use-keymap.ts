import { useEffect, useEffectEvent } from "react";

import { keyPressYields } from "./focus-policy";
import { chordFromEvent, stepKeymap } from "./keymap";
import type { KeySequence, Keymap, Platform } from "./keymap";

const SEQUENCE_TIMEOUT_MS = 1000;

/** The keyboard family of this browser, for resolving `mod` and drawing keycaps. */
export function detectPlatform(): Platform {
  return /mac|iphone|ipad|ipod/iu.test(navigator.userAgent) ? "mac" : "other";
}

/**
 * Run registry shortcuts from window key presses, including two-key sequences such as `g h`.
 *
 * Shortcuts fire whatever has focus, except that a key press yields to a text field, an open menu
 * or dialog, and the keys a focused control uses itself (`keyPressYields`); only entries that set
 * `whileTyping` fire then. Events that something else already handled (`defaultPrevented`) are
 * ignored. A matched shortcut prevents the browser default, so Space on a focused button runs the
 * shortcut instead of pressing the button.
 *
 * @param handlers - What each shortcut does; ids without a handler are ignored.
 */
export function useKeymap<Id extends string>(
  keymap: Keymap<Id>,
  handlers: Partial<Record<Id, (event: KeyboardEvent) => void>>,
): void {
  const handlerFor = useEffectEvent((id: Id) => handlers[id]);

  useEffect(() => {
    let prefix: KeySequence = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const live = new Set(
      keymap.entries.filter((entry) => entry.whileTyping === true).map((entry) => entry.id),
    );

    const unyieldingBindings = keymap.bindings.filter((binding) => live.has(binding.id));

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;

      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;

      const step = keyPressYields(event)
        ? stepKeymap(unyieldingBindings, [], chordFromEvent(event))
        : stepKeymap(keymap.bindings, prefix, chordFromEvent(event));

      clearTimeout(timer);
      prefix = [];

      if (step.kind === "pending") {
        prefix = step.prefix;
        timer = setTimeout(() => {
          prefix = [];
        }, SEQUENCE_TIMEOUT_MS);

        return;
      }

      if (step.kind !== "matched") return;

      const handler = handlerFor(step.id);

      if (handler === undefined) return;

      event.preventDefault();
      handler(event);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [keymap]);
}
