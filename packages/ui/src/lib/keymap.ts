/** Keyboard families that spell shortcuts differently: `⌘` on Apple devices, `Ctrl` elsewhere. */
export type Platform = "mac" | "other";

/** One key press with the modifiers held, after resolving `mod` for the platform. */
export type KeyChord = {
  /** Lowercase character (`g`, `,`, `/`) or lowercase key name (`enter`, `escape`, `arrowup`, `space`). */
  readonly key: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  /** Only compared for letters and named keys; symbols such as `?` already imply it. */
  readonly shift: boolean;
};

/** The chords of a binding pressed one after another, such as `g` then `h`. */
export type KeySequence = ReadonlyArray<KeyChord>;

/** The parts of a keyboard event a chord is read from. */
export type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** A registry entry: what a shortcut does and the keys that trigger it. */
export type KeymapEntry<Id extends string> = {
  readonly id: Id;
  /**
   * Space-separated chords; each chord is `+`-joined modifiers then a key. Modifiers: `mod` (`⌘` on
   * Apple devices, `Ctrl` elsewhere), `meta`, `ctrl`, `alt`, `shift`. Examples: `g h`, `mod+k`,
   * `mod+shift+p`, `/`.
   */
  readonly keys: string;
  /**
   * Fire even while a text field has focus or a menu or dialog is open. Reserve it for chords with
   * `mod`, like `mod+k`.
   */
  readonly whileTyping?: boolean;
};

/** A registry resolved for one platform. */
export type Keymap<Id extends string> = {
  readonly entries: ReadonlyArray<KeymapEntry<Id>>;
  readonly bindings: ReadonlyArray<{ readonly id: Id; readonly sequence: KeySequence }>;
  /** The keycaps to draw for an entry, such as `["G", "H"]` or `["⌘", "⇧", "P"]`. */
  readonly keycaps: (id: Id) => ReadonlyArray<string>;
};

/** The result of feeding one chord to {@link stepKeymap}. */
export type KeymapStep<Id extends string> =
  | { readonly kind: "matched"; readonly id: Id }
  | { readonly kind: "pending"; readonly prefix: KeySequence }
  | { readonly kind: "unmatched" };

const KEY_ALIASES = new Map<string, string>([
  ["esc", "escape"],
  ["return", "enter"],
  ["up", "arrowup"],
  ["down", "arrowdown"],
  ["left", "arrowleft"],
  ["right", "arrowright"],
  [" ", "space"],
  ["spacebar", "space"],
]);

const KEYCAP_LABELS = new Map<string, string>([
  ["enter", "↵"],
  ["escape", "esc"],
  ["backspace", "⌫"],
  ["arrowup", "↑"],
  ["arrowdown", "↓"],
  ["arrowleft", "←"],
  ["arrowright", "→"],
  ["space", "Space"],
  ["tab", "Tab"],
]);

const normalizeKey = (key: string): string => {
  const lower = key.toLowerCase();

  return KEY_ALIASES.get(lower) ?? KEY_ALIASES.get(key) ?? lower;
};

/** Shift changes the meaning of letters and named keys; for symbols it is part of the character. */
const shiftMatters = (key: string): boolean => key.length > 1 || /^\p{L}$/u.test(key);

/**
 * Parse a binding such as `g h` or `mod+shift+p` into the chords it means on `platform`.
 *
 * @throws When the binding is empty or names an unknown modifier: bindings are source literals, so
 *   a malformed one is a programming error.
 */
export function parseKeySequence(binding: string, platform: Platform): KeySequence {
  const steps = binding.trim().split(/\s+/u);

  if (steps.length === 0 || steps[0] === "") throw new Error("A key binding cannot be empty.");

  return steps.map((step) => {
    const parts = step.split("+");
    const key = parts.pop() ?? "";

    if (key === "") throw new Error(`Key binding "${binding}" has no key after "+".`);

    const chord = { key: normalizeKey(key), meta: false, ctrl: false, alt: false, shift: false };

    for (const modifier of parts) {
      switch (modifier.toLowerCase()) {
        case "mod":
          if (platform === "mac") chord.meta = true;
          else chord.ctrl = true;

          break;
        case "meta":
        case "cmd":
          chord.meta = true;

          break;
        case "ctrl":
          chord.ctrl = true;

          break;
        case "alt":
        case "option":
          chord.alt = true;

          break;
        case "shift":
          chord.shift = true;

          break;
        default:
          throw new Error(`Key binding "${binding}" uses an unknown modifier "${modifier}".`);
      }
    }

    return chord;
  });
}

/** Read the chord a keyboard event represents. */
export function chordFromEvent(event: KeyEventLike): KeyChord {
  return {
    key: normalizeKey(event.key),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

/** Whether two chords are the same key press. */
export function chordsEqual(left: KeyChord, right: KeyChord): boolean {
  return (
    left.key === right.key &&
    left.meta === right.meta &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    (!shiftMatters(left.key) || left.shift === right.shift)
  );
}

const startsWith = (sequence: KeySequence, prefix: KeySequence): boolean =>
  prefix.length <= sequence.length &&
  prefix.every((chord, index) => {
    const other = sequence[index];

    return other !== undefined && chordsEqual(chord, other);
  });

/**
 * Advance a multi-key matcher by one chord. Feed the returned `prefix` back in with the next chord
 * while the result is `pending`; start again from an empty prefix after any other result.
 *
 * When the chord does not continue a pending prefix, it is tried as the start of a new sequence,
 * so `g x g h` still reaches `g h`.
 */
export function stepKeymap<Id extends string>(
  bindings: Keymap<Id>["bindings"],
  prefix: KeySequence,
  chord: KeyChord,
): KeymapStep<Id> {
  const candidate = [...prefix, chord];

  const exact = bindings.find(
    (binding) =>
      binding.sequence.length === candidate.length && startsWith(binding.sequence, candidate),
  );

  if (exact !== undefined) return { kind: "matched", id: exact.id };

  if (bindings.some((binding) => startsWith(binding.sequence, candidate))) {
    return { kind: "pending", prefix: candidate };
  }

  return prefix.length > 0 ? stepKeymap(bindings, [], chord) : { kind: "unmatched" };
}

/** The keycaps for a sequence: modifiers as separate caps in `⌃ ⌥ ⌘ ⇧` order, then the key. */
export function formatKeycaps(sequence: KeySequence, platform: Platform): ReadonlyArray<string> {
  const mac = platform === "mac";

  return sequence.flatMap((chord) => {
    const caps: Array<string> = [];

    if (chord.ctrl) caps.push(mac ? "⌃" : "Ctrl");

    if (chord.alt) caps.push(mac ? "⌥" : "Alt");

    if (chord.meta) caps.push(mac ? "⌘" : "Win");

    if (chord.shift) caps.push(mac ? "⇧" : "Shift");

    caps.push(KEYCAP_LABELS.get(chord.key) ?? chord.key.toUpperCase());

    return caps;
  });
}

/**
 * Resolve a shortcut registry for one platform.
 *
 * @throws When two entries share an id, or one entry's keys are a prefix of another's (the shorter
 *   one would always fire first and the longer one could never be reached).
 */
export function createKeymap<Id extends string>(
  entries: ReadonlyArray<KeymapEntry<Id>>,
  platform: Platform,
): Keymap<Id> {
  const bindings = entries.map((entry) => ({
    id: entry.id,
    sequence: parseKeySequence(entry.keys, platform),
  }));

  const ids = new Set<Id>();

  for (const binding of bindings) {
    if (ids.has(binding.id)) throw new Error(`Shortcut "${binding.id}" is registered twice.`);

    ids.add(binding.id);

    const shadowed = bindings.find(
      (other) => other !== binding && startsWith(other.sequence, binding.sequence),
    );

    if (shadowed !== undefined) {
      throw new Error(`Shortcut "${binding.id}" blocks "${shadowed.id}": its keys are a prefix.`);
    }
  }

  const caps = new Map(
    bindings.map((binding) => [binding.id, formatKeycaps(binding.sequence, platform)]),
  );

  return { entries, bindings, keycaps: (id) => caps.get(id) ?? [] };
}
